import { pgTable, uuid, text, integer, real, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';

/**
 * Per-call cost/usage ledger for Anthropic API calls (S4.2 Privacy and cost
 * controls) -- one row per attempt, whether it actually reached Anthropic or
 * not. Append-only in spirit, same pattern as `feedback_summaries`/
 * `loyalty_transactions`/`audit_log` -- a correction is a new row, not an
 * edit to an old one's substantive facts -- with ONE deliberate exception
 * (S4 roadmap Block 7, S4.3 "mark processing pending or failed"): a
 * 'pending' row is updated in place, once, to its final 'success'/'failed'
 * outcome (AiUsageLogRepository.resolve). That is not "correcting history"
 * the way the append-only rule guards against -- it is the SAME attempt
 * reaching its real conclusion, and `resolvedAt` (below) records when that
 * happened without losing `createdAt`'s own "when this attempt began."
 *
 * `status` captures the four states an aggregation-run attempt can be in:
 *   - 'pending' -- an attempt has started (SummaryService.generateForPeriod
 *     passed its spend-limit check and began the real work) but has not
 *     yet concluded either way. Written first, before any Anthropic call or
 *     even the feedback/cross-domain reads that build its prompt, so an
 *     attempt that never reaches either outcome below (e.g. this Worker
 *     invocation is killed mid-flight) is still visible as a stuck
 *     'pending' row instead of leaving no trace anywhere -- the exact gap
 *     this block closes. `resolvedAt` stays NULL for as long as a row is
 *     genuinely pending.
 *   - 'success' -- Anthropic responded; inputTokens/outputTokens/
 *     costEstimateUsd are all real numbers from the API's own `usage` block.
 *   - 'failed' -- the call was attempted but the response never came back
 *     (network error, non-2xx status) -- inputTokens/outputTokens/
 *     costEstimateUsd are all NULL, since no tokens are billed for a failed
 *     request.
 *   - 'blocked' -- SummaryService's spend-limit check rejected the call
 *     before it was ever made (see summary.service.ts's enforceSpendLimit) --
 *     every token/cost column is NULL because nothing was sent. Written
 *     directly as a terminal row, never via a 'pending' row first -- a
 *     blocked attempt never starts the work 'pending' represents.
 *   - 'abandoned' (S4 roadmap Block 9) -- a 'pending' row that never
 *     reported an outcome within STALE_PENDING_MINUTES, swept to a terminal
 *     state by sweepStalePendingAiUsage (index.ts). Deliberately its own
 *     status rather than reusing 'failed': 'failed' asserts the specific
 *     fact that the call was attempted and no usable response came back, so
 *     no tokens were billed. For an abandoned row that assertion would be a
 *     guess -- the invocation died somewhere between writing this row and
 *     resolving it, and from the outside there is no way to tell whether it
 *     died before the Anthropic call, during it, or after a response was
 *     already billed but before resolve() ran. The two also mean different
 *     things operationally: a spike in 'failed' points at Anthropic being
 *     unhealthy, a spike in 'abandoned' points at this Worker being killed
 *     mid-flight (CPU limit, eviction, deploy). Collapsing them would lose
 *     exactly the signal that distinguishes "their problem" from "ours".
 *
 *     Every token/cost column stays NULL on an abandoned row, for the same
 *     reason resolvedAt stays NULL on pre-Block-7 rows: an unknown value is
 *     recorded as unknown, never fabricated. The honest consequence is that
 *     an abandoned attempt which DID reach Anthropic contributes nothing to
 *     totalCostSince, so real spend can be under-counted by however much
 *     those attempts actually cost. That is a known, accepted residual risk
 *     of this design -- the alternative (estimating a cost for a call whose
 *     outcome is unknown) would put invented numbers into the ledger that
 *     the spend limit then treats as fact, which is worse than a bounded
 *     undercount. The sweep logs how many rows it abandons precisely so the
 *     size of that undercount is observable rather than silent; a sustained
 *     non-zero count is the signal to investigate, not to widen the limit.
 * Only 'success' rows carry a non-NULL costEstimateUsd, so the daily/monthly
 * spend-limit query (AiUsageLogRepository.totalCostSince) is a plain SUM
 * with a `status = 'success'` filter and nothing more elaborate --
 * 'pending' rows are excluded by that same filter automatically, so a
 * still-in-flight attempt can never be double-counted or miscounted as
 * spend.
 *
 * `callSite` is open text, not CHECK-constrained -- same reasoning as
 * feedback.category/fraud_signals.signalType: 'summary_generation' is the
 * only value S4 produces today, but follow-up-question-generator.ts already
 * makes a second, unrelated per-submission Anthropic call this table could
 * extend to cover later without a migration; this table's shape doesn't
 * presuppose that decision either way.
 *
 * `businessId`/`branchId`/`periodType`/`periodStart`/`periodEnd` are
 * denormalized here rather than a FK back to `feedback_summaries`,
 * deliberately: a 'blocked' or 'failed' row is written specifically because
 * no feedback_summaries row exists yet (or ever will, for that attempt), so
 * a NOT NULL FK can't work and a nullable one would need a second, separate
 * write to backfill after the fact. These columns alone already fully
 * identify "the aggregation run" per S4.2's own wording.
 */
export const aiUsageLog = pgTable(
  'ai_usage_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    callSite: text('call_site').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    // Same daily/weekly/monthly constraint as feedback_summaries.periodType --
    // widened together for the daily cadence (S4.1 roadmap Block 3).
    periodType: text('period_type').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costEstimateUsd: real('cost_estimate_usd'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // S4 roadmap Block 7 -- NULL while status='pending'; set the one time a
    // row transitions to 'success'/'failed' via AiUsageLogRepository.resolve.
    // Always NULL for 'blocked' rows (never pending, never resolved -- see
    // this table's own doc comment above), and for every 'success'/'failed'
    // row written before this block shipped (there is no way to backfill a
    // resolution time that was never recorded; NULL is the honest value,
    // not a fabricated guess).
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    // Backs totalCostSince's WHERE status = 'success' AND created_at >= X --
    // the spend-limit check runs on every summary-generation attempt (the
    // cron sweep pages through every business), so this is a hot path.
    // Partial, same reasoning as fraud_signals_business_open_idx/
    // critical_incidents_unacknowledged_idx: successful rows are the
    // overwhelming majority in steady state, but the query only ever cares
    // about them, never about 'failed'/'blocked'/'pending' rows.
    index('ai_usage_log_success_created_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'success'`),
    index('ai_usage_log_business_created_idx').on(table.businessId, table.createdAt),
    // Backs an operational "find stuck attempts" query (WHERE status =
    // 'pending' AND created_at < some cutoff) -- S4 roadmap Block 7 makes
    // this the first time such a query is even possible; no code path
    // queries it automatically yet (no scheduled sweep exists for stale
    // pending rows, unlike e.g. sweepUnacknowledgedCriticalIncidents --
    // flagged as a natural follow-up, not implemented speculatively here).
    // Partial for the same reason as the two indexes above: pending rows
    // are rare and short-lived in steady state.
    index('ai_usage_log_pending_created_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    check(
      'ai_usage_log_status_check',
      sql`${table.status} IN ('pending', 'success', 'failed', 'blocked', 'abandoned')`,
    ),
    check('ai_usage_log_period_type_check', sql`${table.periodType} IN ('daily', 'weekly', 'monthly')`),
    check('ai_usage_log_period_range_check', sql`${table.periodEnd} > ${table.periodStart}`),
  ],
);
