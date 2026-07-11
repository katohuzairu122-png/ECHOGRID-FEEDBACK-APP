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
    options: { branchId?: string; periodType?: 'weekly' | 'monthly'; limit?: number; offset?: number } = {},
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

  async findById(id: string, businessId: string): Promise<FeedbackSummary | undefined> {
    return this.db.query.feedbackSummaries.findFirst({
      where: and(eq(feedbackSummaries.id, id), eq(feedbackSummaries.businessId, businessId)),
    });
  }
}
