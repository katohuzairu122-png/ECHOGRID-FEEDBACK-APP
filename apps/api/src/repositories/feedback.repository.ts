import { eq, and, gte, lte, ilike, sql, inArray, isNull, isNotNull, asc, desc } from 'drizzle-orm';
import { feedback } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { FeedbackFilterInput } from '@echo-grid-feedback/shared-types';

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
export type SentimentTrendBucket = {
  bucket: string;
  positive: number;
  neutral: number;
  negative: number;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Internal safety cap for SummaryService's period sweep -- not a product
// limit (see "never hard-code limits"), a defensive bound so one
// pathologically high-volume business/period can't pull an unbounded result
// set into Worker memory. SummaryService additionally caps prompt size
// separately (MAX_COMMENTS_IN_PROMPT); this cap protects the query itself.
const MAX_PERIOD_ROWS = 5000;

// The analytics search dashboard's sentiment filter (analytics.routes.ts)
// still only offers the original 3 options (positive/neutral/negative) --
// that UI's own scope, unchanged here. Without this expansion, selecting
// "positive" there would silently stop matching 'very_positive' rows now
// that the sentiment scale has 5 values instead of 3 (Automated Feedback
// Sorting), a real regression to an already-shipped feature this repository
// method must not introduce just by widening the underlying column's range.
const SENTIMENT_SEARCH_ALIASES: Record<string, readonly string[]> = {
  positive: ['positive', 'very_positive'],
  negative: ['negative', 'very_negative'],
};

export class FeedbackRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<Feedback | undefined> {
    return this.db.query.feedback.findFirst({
      where: and(
        eq(feedback.id, id),
        eq(feedback.businessId, businessId),
        eq(feedback.isDeleted, false),
      ),
    });
  }

  async listForBusiness(
    businessId: string,
    options: { branchId?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<Feedback[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = options.offset ?? 0;
    return this.db.query.feedback.findMany({
      where: and(
        eq(feedback.businessId, businessId),
        eq(feedback.isDeleted, false),
        options.branchId ? eq(feedback.branchId, options.branchId) : undefined,
      ),
      limit,
      offset,
      orderBy: (f, { desc }) => [desc(f.createdAt)],
    });
  }

  /**
   * No businessId/auth required -- this is the write side of the public,
   * anonymous submission flow (Block 2's POST /qr/:token/feedback). The
   * caller resolves qrCodeId/branchId/businessId from the token first
   * (QrCodeRepository.findActiveByToken), then passes them in here.
   */
  async create(input: NewFeedback): Promise<Feedback> {
    const [row] = await this.db.insert(feedback).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async markReviewed(id: string, businessId: string, updatedBy: string): Promise<Feedback | undefined> {
    const [row] = await this.db
      .update(feedback)
      .set({ status: 'reviewed', updatedBy, updatedAt: new Date() })
      .where(
        and(
          eq(feedback.id, id),
          eq(feedback.businessId, businessId),
          eq(feedback.isDeleted, false),
        ),
      )
      .returning();
    return row;
  }

  async softDelete(id: string, businessId: string, deletedBy: string): Promise<void> {
    await this.db
      .update(feedback)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
      .where(and(eq(feedback.id, id), eq(feedback.businessId, businessId)));
  }

  /**
   * Written by SentimentService only -- no `updatedBy` here because this is
   * system/AI-generated state, not a staff edit, matching how
   * `loyalty_transactions.createdBy` stays NULL for customer-initiated rows.
   * `businessId` is still required despite the caller (queue consumer)
   * being trusted infrastructure, not a request handler -- defense in depth
   * against a malformed job message ever cross-tenant-writing a row.
   */
  async updateSentiment(
    id: string,
    businessId: string,
    patch: {
      sentiment?: string;
      sentimentScore?: number;
      analysisStatus: 'completed' | 'failed' | 'skipped';
      analyzedAt: Date;
      // Automated Feedback Sorting -- category/urgency ride along on the
      // same UPDATE as sentiment (Level 2 classification computes all
      // three together), not a separate method/round-trip.
      category?: string;
      urgency?: string;
    },
  ): Promise<Feedback | undefined> {
    const [row] = await this.db
      .update(feedback)
      .set(patch)
      .where(and(eq(feedback.id, id), eq(feedback.businessId, businessId)))
      .returning();
    return row;
  }

  /** Feeds SummaryService's period rollup -- see MAX_PERIOD_ROWS above for
   * why this is capped even though callers pass an explicit date range. */
  async listForPeriod(
    businessId: string,
    options: { branchId?: string | undefined; from: Date; to: Date },
  ): Promise<Feedback[]> {
    return this.db.query.feedback.findMany({
      where: and(
        eq(feedback.businessId, businessId),
        eq(feedback.isDeleted, false),
        options.branchId ? eq(feedback.branchId, options.branchId) : undefined,
        gte(feedback.createdAt, options.from),
        lte(feedback.createdAt, options.to),
      ),
      limit: MAX_PERIOD_ROWS,
      orderBy: (f, { desc }) => [desc(f.createdAt)],
    });
  }

  /**
   * Searchable feedback (analytics dashboard, Block 4) -- keyword matches
   * `comment` only (customerName/Email/Phone deliberately excluded from
   * free-text search to avoid this becoming an accidental PII lookup tool
   * for staff beyond what feedback:view already grants).
   */
  async search(
    businessId: string,
    options: {
      branchId?: string | undefined;
      sentiment?: 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive' | 'unknown' | undefined;
      rating?: number | undefined;
      keyword?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<Feedback[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return this.db.query.feedback.findMany({
      where: and(
        eq(feedback.businessId, businessId),
        eq(feedback.isDeleted, false),
        options.branchId ? eq(feedback.branchId, options.branchId) : undefined,
        options.sentiment
          ? inArray(feedback.sentiment, SENTIMENT_SEARCH_ALIASES[options.sentiment] ?? [options.sentiment])
          : undefined,
        options.rating ? eq(feedback.rating, options.rating) : undefined,
        options.keyword ? ilike(feedback.comment, `%${options.keyword}%`) : undefined,
        options.from ? gte(feedback.createdAt, options.from) : undefined,
        options.to ? lte(feedback.createdAt, options.to) : undefined,
      ),
      limit,
      offset: options.offset ?? 0,
      orderBy: (f, { desc }) => [desc(f.createdAt)],
    });
  }

  /**
   * Day-bucketed sentiment counts for the trend chart. Returns one row per
   * (day, sentiment) pair from Postgres and pivots to one row per day in
   * application code -- simpler and more portable than a SQL PIVOT/
   * crosstab, and the row count here is small (days-in-range x 3) so the
   * in-memory pivot cost is negligible.
   */
  async sentimentTrend(
    businessId: string,
    options: { branchId?: string | undefined; from: Date; to: Date },
  ): Promise<SentimentTrendBucket[]> {
    const rows = await this.db
      .select({
        bucket: sql<string>`date_trunc('day', ${feedback.createdAt})::date::text`,
        sentiment: feedback.sentiment,
        count: sql<number>`count(*)::int`,
      })
      .from(feedback)
      .where(
        and(
          eq(feedback.businessId, businessId),
          eq(feedback.isDeleted, false),
          options.branchId ? eq(feedback.branchId, options.branchId) : undefined,
          gte(feedback.createdAt, options.from),
          lte(feedback.createdAt, options.to),
        ),
      )
      .groupBy(sql`date_trunc('day', ${feedback.createdAt})`, feedback.sentiment)
      .orderBy(sql`date_trunc('day', ${feedback.createdAt})`);

    const byBucket = new Map<string, SentimentTrendBucket>();
    for (const row of rows) {
      const entry = byBucket.get(row.bucket) ?? {
        bucket: row.bucket,
        positive: 0,
        neutral: 0,
        negative: 0,
      };
      // Folds the 5-value scale (very_negative/negative/neutral/positive/
      // very_positive, Automated Feedback Sorting) into this existing
      // 3-bucket trend chart -- the chart's own contract/UI isn't part of
      // this change, so 'very_positive' counts into `positive` and
      // 'very_negative' into `negative` rather than silently vanishing (the
      // bug this fix avoids: an if/else chain checking only the original 3
      // string literals would drop the new values' counts entirely). 5-value
      // granularity is still fully queryable on the raw `sentiment` column
      // itself (inbox filtering) -- only this rollup collapses it.
      if (row.sentiment === 'positive' || row.sentiment === 'very_positive') entry.positive += row.count;
      else if (row.sentiment === 'neutral') entry.neutral += row.count;
      else if (row.sentiment === 'negative' || row.sentiment === 'very_negative') entry.negative += row.count;
      byBucket.set(row.bucket, entry);
    }
    return Array.from(byBucket.values());
  }

  /**
   * The inbox's own filter/sort/paginate query (Automated Feedback Sorting)
   * -- deliberately separate from `search` above (the analytics dashboard's
   * older, narrower query), since the two evolve independently and this one
   * needs the full multi-select filter surface `search` was never designed
   * for. Fetches `limit + 1` rows and slices instead of a separate COUNT
   * query, matching this file's own stated "avoid COUNT on a potentially
   * large, frequently-paginated table" reasoning (see MAX_PERIOD_ROWS above) --
   * `hasMore` is all a paginated inbox actually needs to render a Next button.
   */
  async listWithFilters(
    businessId: string,
    filters: Omit<FeedbackFilterInput, 'savedView'>,
  ): Promise<{ items: Feedback[]; hasMore: boolean }> {
    const limit = Math.min(filters.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = filters.offset ?? 0;

    const conditions = [
      eq(feedback.businessId, businessId),
      eq(feedback.isDeleted, false),
      filters.branchId ? eq(feedback.branchId, filters.branchId) : undefined,
      filters.category?.length ? inArray(feedback.category, filters.category) : undefined,
      filters.urgency?.length ? inArray(feedback.urgency, filters.urgency) : undefined,
      filters.sentiment?.length ? inArray(feedback.sentiment, filters.sentiment) : undefined,
      filters.status?.length ? inArray(feedback.status, filters.status) : undefined,
      filters.analysisStatus?.length ? inArray(feedback.analysisStatus, filters.analysisStatus) : undefined,
      filters.assignedTo ? eq(feedback.assignedTo, filters.assignedTo) : undefined,
      filters.unassigned ? isNull(feedback.assignedTo) : undefined,
      filters.followUpRequired
        ? and(isNotNull(feedback.followUpQuestion), isNull(feedback.followUpAnswer))
        : undefined,
      filters.search ? ilike(feedback.comment, `%${filters.search}%`) : undefined,
      filters.dateFrom ? gte(feedback.createdAt, new Date(filters.dateFrom)) : undefined,
      filters.dateTo ? lte(feedback.createdAt, new Date(filters.dateTo)) : undefined,
    ];

    const direction = filters.sortDirection === 'asc' ? asc : desc;
    // Text-sorting urgency works out correctly by coincidence: the P0-P3
    // labels are alphabetically ordered the same as their real severity
    // (P0_CRITICAL < P1_HIGH < P2_NORMAL < P3_LOW), so no CASE expression or
    // numeric mapping is needed to get "most urgent first" from a plain
    // ascending sort on the column's own text value.
    const sortColumn =
      filters.sortBy === 'urgency' ? feedback.urgency : filters.sortBy === 'rating' ? feedback.rating : feedback.createdAt;

    const rows = await this.db.query.feedback.findMany({
      where: and(...conditions),
      orderBy: [direction(sortColumn), desc(feedback.createdAt)],
      limit: limit + 1,
      offset,
    });

    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async assign(id: string, businessId: string, assignedTo: string | null, updatedBy: string): Promise<Feedback | undefined> {
    const [row] = await this.db
      .update(feedback)
      .set({ assignedTo, updatedBy, updatedAt: new Date() })
      .where(and(eq(feedback.id, id), eq(feedback.businessId, businessId), eq(feedback.isDeleted, false)))
      .returning();
    return row;
  }

  /** Returns the rows actually updated -- not just an ack -- so the caller
   * (bulk action endpoint) can report exactly how many of the requested ids
   * existed and were writable, same "tell the truth about what happened"
   * principle as every other mutation in this repository. */
  async bulkAssign(
    ids: string[],
    businessId: string,
    assignedTo: string | null,
    updatedBy: string,
  ): Promise<Feedback[]> {
    return this.db
      .update(feedback)
      .set({ assignedTo, updatedBy, updatedAt: new Date() })
      .where(and(inArray(feedback.id, ids), eq(feedback.businessId, businessId), eq(feedback.isDeleted, false)))
      .returning();
  }

  async bulkMarkReviewed(ids: string[], businessId: string, updatedBy: string): Promise<Feedback[]> {
    return this.db
      .update(feedback)
      .set({ status: 'reviewed', updatedBy, updatedAt: new Date() })
      .where(and(inArray(feedback.id, ids), eq(feedback.businessId, businessId), eq(feedback.isDeleted, false)))
      .returning();
  }
}
