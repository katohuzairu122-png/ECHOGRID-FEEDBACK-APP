import { pgTable, uuid, text, integer, real, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';

/**
 * Per-call cost/usage ledger for Anthropic API calls (S4.2 Privacy and cost
 * controls) -- one row per attempt, whether it actually reached Anthropic or
 * not. Append-only, same pattern as `feedback_summaries`/`loyalty_transactions`/
 * `audit_log`: no updatedAt, no soft-delete, a correction is a new row.
 *
 * `status` captures all three outcomes an aggregation-run attempt can have:
 *   - 'success' -- Anthropic responded; inputTokens/outputTokens/
 *     costEstimateUsd are all real numbers from the API's own `usage` block.
 *   - 'failed' -- the call was attempted but the response never came back
 *     (network error, non-2xx status) -- inputTokens/outputTokens/
 *     costEstimateUsd are all NULL, since no tokens are billed for a failed
 *     request.
 *   - 'blocked' -- SummaryService's spend-limit check rejected the call
 *     before it was ever made (see summary.service.ts's enforceSpendLimit) --
 *     every token/cost column is NULL because nothing was sent.
 * Only 'success' rows carry a non-NULL costEstimateUsd, so the daily/monthly
 * spend-limit query (AiUsageLogRepository.totalCostSince) is a plain SUM
 * with a `status = 'success'` filter and nothing more elaborate.
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
  },
  (table) => [
    // Backs totalCostSince's WHERE status = 'success' AND created_at >= X --
    // the spend-limit check runs on every summary-generation attempt (the
    // cron sweep pages through every business), so this is a hot path.
    // Partial, same reasoning as fraud_signals_business_open_idx/
    // critical_incidents_unacknowledged_idx: successful rows are the
    // overwhelming majority in steady state, but the query only ever cares
    // about them, never about 'failed'/'blocked' rows.
    index('ai_usage_log_success_created_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'success'`),
    index('ai_usage_log_business_created_idx').on(table.businessId, table.createdAt),
    check('ai_usage_log_status_check', sql`${table.status} IN ('success', 'failed', 'blocked')`),
    check('ai_usage_log_period_type_check', sql`${table.periodType} IN ('daily', 'weekly', 'monthly')`),
    check('ai_usage_log_period_range_check', sql`${table.periodEnd} > ${table.periodStart}`),
  ],
);
