import { and, eq, gte, sql } from 'drizzle-orm';
import { aiUsageLog } from '../db/schema';
import { BaseRepository } from './base.repository';

export type AiUsageLog = typeof aiUsageLog.$inferSelect;
export type NewAiUsageLog = typeof aiUsageLog.$inferInsert;

export class AiUsageLogRepository extends BaseRepository {
  /** Records one Anthropic call attempt -- success, failed, or blocked (see
   * ai-usage-log.ts's schema comment for what each means). Called exactly
   * once per SummaryService.generateForPeriod invocation, regardless of
   * outcome, so the spend-limit check (totalCostSince) always sees a
   * complete picture of every attempt, not just the successful ones. */
  async record(input: NewAiUsageLog): Promise<AiUsageLog> {
    const [row] = await this.db.insert(aiUsageLog).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Platform-wide total of actually-incurred Anthropic spend since `since`
   * (inclusive) -- backs SummaryService's daily/monthly spend-limit check
   * (S4.2). Deliberately NOT scoped to one business: this protects Echo
   * Grid's own Anthropic bill (an operational cost the platform absorbs,
   * not a per-tenant charge passed through to businesses), the same
   * "protect our own infrastructure cost" reasoning FOLLOWUP_QUESTION_RATE_LIMITER
   * already uses elsewhere, just for spend instead of request volume. Only
   * 'success' rows have a non-NULL costEstimateUsd (see schema comment), so
   * no CASE expression is needed beyond the WHERE clause below.
   */
  async totalCostSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${aiUsageLog.costEstimateUsd}), 0)` })
      .from(aiUsageLog)
      .where(and(eq(aiUsageLog.status, 'success'), gte(aiUsageLog.createdAt, since)));
    return Number(row?.total ?? 0);
  }
}
