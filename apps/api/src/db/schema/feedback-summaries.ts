import { pgTable, uuid, text, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';

/**
 * AI-generated periodic rollups (Sentiment Analytics Block 3) -- one row per
 * business (or business+branch) per period, produced by an async queue
 * consumer that batches recent `feedback` rows through an LLM for a prose
 * summary + actionable recommendations, plus a plain sentiment-count
 * breakdown for trend charts.
 *
 * Modeled as an append-only ledger, same pattern as `loyalty_transactions`
 * and `audit_log`: `createdAt`/`createdBy` only, no `updatedAt`/soft-delete.
 * Regenerating a period (e.g. a manual re-run) inserts a new row rather than
 * editing the old one -- this keeps a clean history of what a business was
 * told at each point in time, which matters for an AI-generated artifact a
 * business might act on and later want to audit.
 *
 * `branchId` is nullable on purpose: a NULL branch means a business-wide
 * rollup across all branches, not a missing/unassigned value -- the two
 * cases (business-wide vs. one branch) are genuinely different report types,
 * not the same query with an optional filter, so both need to exist as
 * distinct rows addressable by the analytics API (Block 4).
 */
export const feedbackSummaries = pgTable(
  'feedback_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    periodType: text('period_type').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    feedbackCount: integer('feedback_count').notNull(),
    positiveCount: integer('positive_count').notNull().default(0),
    neutralCount: integer('neutral_count').notNull().default(0),
    negativeCount: integer('negative_count').notNull().default(0),
    // Prose, not structured JSON -- an LLM summary reads naturally as text;
    // forcing it into rigid fields would lose nuance for marginal query
    // benefit no current screen needs.
    summary: text('summary').notNull(),
    // One recommendation per line, rendered as a list client-side -- kept as
    // plain text (not jsonb) so the LLM's own numbered/bulleted output can be
    // stored close to verbatim instead of requiring strict-JSON prompting,
    // which is a real reliability risk for LLM output (see AI Standards:
    // "reduce hallucination risk," not "reduce JSON-parse-failure risk").
    recommendations: text('recommendations').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'), // NULL for system/queue-generated rows (the only kind today)
  },
  (table) => [
    index('feedback_summaries_business_period_idx').on(
      table.businessId,
      table.periodType,
      table.periodStart,
    ),
    index('feedback_summaries_branch_period_idx').on(table.branchId, table.periodStart),
    check(
      'feedback_summaries_period_type_check',
      sql`${table.periodType} IN ('weekly', 'monthly')`,
    ),
    check('feedback_summaries_period_range_check', sql`${table.periodEnd} > ${table.periodStart}`),
    check('feedback_summaries_counts_check', sql`${table.feedbackCount} >= 0`),
  ],
);
