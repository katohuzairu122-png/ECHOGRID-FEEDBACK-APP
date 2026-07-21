import { eq, and, gte, lte, ilike, sql } from 'drizzle-orm';
import { feedback } from '../db/schema';
import { BaseRepository } from './base.repository';

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
    options: { branchId?: string; limit?: number; offset?: number } = {},
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
    options: { branchId?: string; from: Date; to: Date },
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
      branchId?: string;
      sentiment?: 'positive' | 'neutral' | 'negative';
      rating?: number;
      keyword?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Feedback[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return this.db.query.feedback.findMany({
      where: and(
        eq(feedback.businessId, businessId),
        eq(feedback.isDeleted, false),
        options.branchId ? eq(feedback.branchId, options.branchId) : undefined,
        options.sentiment ? eq(feedback.sentiment, options.sentiment) : undefined,
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
    options: { branchId?: string; from: Date; to: Date },
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
      if (row.sentiment === 'positive') entry.positive = row.count;
      else if (row.sentiment === 'neutral') entry.neutral = row.count;
      else if (row.sentiment === 'negative') entry.negative = row.count;
      byBucket.set(row.bucket, entry);
    }
    return Array.from(byBucket.values());
  }
}
