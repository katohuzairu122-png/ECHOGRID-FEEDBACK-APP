import { and, eq, gte, sql } from 'drizzle-orm';
import { aiUsageLog } from '../db/schema';
import { BaseRepository } from './base.repository';

export type AiUsageLog = typeof aiUsageLog.$inferSelect;
export type NewAiUsageLog = typeof aiUsageLog.$inferInsert;

export class AiUsageLogRepository extends BaseRepository {
  /** Writes one new row -- a terminal 'blocked' row (enforceSpendLimit), or
   * (S4 roadmap Block 7) the initial 'pending' row an in-progress attempt
   * starts as, later updated in place by resolve() below. Called exactly
   * once per SummaryService.generateForPeriod invocation for the 'pending'/
   * 'blocked' cases -- never called a second time for the same attempt;
   * 'success'/'failed' outcomes go through resolve(), not a second record()
   * call, so one attempt is always exactly one row. */
  async record(input: NewAiUsageLog): Promise<AiUsageLog> {
    const [row] = await this.db.insert(aiUsageLog).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * S4 roadmap Block 7 (S4.3 "mark processing pending or failed"). Resolves
   * a 'pending' row (written by record() at the start of an attempt) to its
   * real outcome -- the one deliberate exception to this table's append-
   * only convention, see ai-usage-log.ts's own schema comment for why.
   * Guarded by `WHERE status = 'pending'`, same one-way-transition idiom as
   * CriticalIncidentRepository.acknowledge/FraudSignalRepository.markReviewed
   * -- resolving an already-resolved row is a safe no-op (returns
   * undefined), not an error. No real caller triggers that today (a queue
   * retry re-invokes generateForPeriod from scratch, which writes a fresh
   * 'pending' row rather than re-resolving an old one), but the guard costs
   * nothing and matches this codebase's established convention for a
   * one-way state transition.
   *
   * `model`/`promptVersion` are re-specified here, not left untouched from
   * the pending insert -- on success SummaryService passes
   * `result.usage.model`/`result.usage.promptVersion` to correct them from
   * whatever was configured at pending-time to what the generator that
   * actually ran reports about itself (dev/staging's ConsoleSummaryGenerator
   * honestly reports 'console-dev-fallback', not the configured model that
   * was never actually called -- see summary.service.ts's own comment). On
   * failure the caller re-passes the same values recorded at pending-time,
   * a no-op overwrite -- kept required rather than optional so this method
   * has one uniform, fully-specified shape regardless of which status is
   * being set.
   */
  async resolve(
    id: string,
    updates: {
      status: 'success' | 'failed';
      model: string;
      promptVersion: string;
      inputTokens: number | null;
      outputTokens: number | null;
      costEstimateUsd: number | null;
    },
  ): Promise<AiUsageLog | undefined> {
    const [row] = await this.db
      .update(aiUsageLog)
      .set({ ...updates, resolvedAt: new Date() })
      .where(and(eq(aiUsageLog.id, id), eq(aiUsageLog.status, 'pending')))
      .returning();
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
