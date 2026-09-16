import { eq, and, isNull, desc } from 'drizzle-orm';
import { feedbackSummaries } from '../db/schema';
import { BaseRepository } from './base.repository';

export type FeedbackSummary = typeof feedbackSummaries.$inferSelect;
export type NewFeedbackSummary = typeof feedbackSummaries.$inferInsert;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class FeedbackSummaryRepository extends BaseRepository {
  async create(input: NewFeedbackSummary): Promise<FeedbackSummary> {
    const [row] = await this.db.insert(feedbackSummaries).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * `branchId: undefined` means "business-wide rollups only" (matches the
   * schema's NULL-means-business-wide convention); passing a real branchId
   * scopes to that branch's own rollups instead. The two are never mixed in
   * one query -- a caller wanting both makes two calls, since they're
   * different report types (see feedback-summaries.ts's schema comment).
   */
  async listForBusiness(
    businessId: string,
    options: { branchId?: string | undefined; periodType?: 'daily' | 'weekly' | 'monthly' | undefined; limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<FeedbackSummary[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return this.db.query.feedbackSummaries.findMany({
      where: and(
        eq(feedbackSummaries.businessId, businessId),
        options.branchId ? eq(feedbackSummaries.branchId, options.branchId) : isNull(feedbackSummaries.branchId),
        options.periodType ? eq(feedbackSummaries.periodType, options.periodType) : undefined,
      ),
      limit,
      offset: options.offset ?? 0,
      orderBy: desc(feedbackSummaries.periodStart),
    });
  }

  /**
   * The most recent summary already stored for one exact period, or
   * undefined. Backs SummaryService.generateForPeriod's idempotency guard
   * (audit P2-2): a queue retry of work that already succeeded must not pay
   * Anthropic a second time.
   *
   * `branchId: undefined` means the BUSINESS-WIDE rollup and matches on
   * `IS NULL`, not `= NULL` -- the same distinction listForBusiness above
   * already makes, and the reason this is a hand-built predicate rather
   * than a spread of the options object. `eq(branchId, null)` compiles to
   * `= NULL`, which is never true in SQL, so it would silently match
   * nothing and the guard would never fire on the most common case.
   *
   * Ordered by createdAt descending, not periodStart: this table is an
   * append-only ledger (see the schema comment), so a deliberately
   * regenerated period has several rows for the same periodStart and the
   * newest is the one in force.
   */
  async findLatestForPeriod(
    businessId: string,
    options: {
      branchId?: string | undefined;
      periodType: 'daily' | 'weekly' | 'monthly';
      periodStart: Date;
    },
  ): Promise<FeedbackSummary | undefined> {
    return this.db.query.feedbackSummaries.findFirst({
      where: and(
        eq(feedbackSummaries.businessId, businessId),
        options.branchId
          ? eq(feedbackSummaries.branchId, options.branchId)
          : isNull(feedbackSummaries.branchId),
        eq(feedbackSummaries.periodType, options.periodType),
        eq(feedbackSummaries.periodStart, options.periodStart),
      ),
      orderBy: desc(feedbackSummaries.createdAt),
    });
  }

  async findById(id: string, businessId: string): Promise<FeedbackSummary | undefined> {
    return this.db.query.feedbackSummaries.findFirst({
      where: and(eq(feedbackSummaries.id, id), eq(feedbackSummaries.businessId, businessId)),
    });
  }
}
