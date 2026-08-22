import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { feedback } from './feedback';

/**
 * One row per feedback submission that Level-1 deterministic processing
 * flagged as a credible safety/fraud emergency (immediate danger, fire,
 * assault, food poisoning, severe allergic reaction, medical emergency,
 * active fraud, serious security incident) -- see
 * feedback/critical-detector.ts for the keyword list. Created synchronously
 * in the same request that stores the feedback row, never waiting on any AI
 * classification, so an incident record always exists the instant a P0
 * submission is stored.
 *
 * `acknowledgedAt`/`acknowledgedBy` and `escalatedAt` are nullable
 * timestamps used as the state markers, not a separate `status` enum --
 * same "one-way UPDATE guarded by WHERE x IS NULL" convention
 * loyalty_transactions.redemptionConfirmedAt already uses. An unacknowledged
 * incident is exactly the row where acknowledgedAt IS NULL; the escalation
 * sweep (a scheduled job) targets that same condition.
 *
 * No FK to `users` for acknowledgedBy, matching auditColumns' createdBy
 * convention elsewhere in this schema -- metadata, not relational integrity.
 *
 * All three tenant FKs cascade, same as feedback.ts's own reasoning: this is
 * tenant-owned operational data tied 1:1 to a feedback row, not an immutable
 * compliance trail that must survive the business being deleted.
 */
export const criticalIncidents = pgTable(
  'critical_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id')
      .notNull()
      .unique()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    // Which keyword pattern(s) fired -- a short, human-readable reason a
    // manager reviewing the incident (or auditing a false positive) can see
    // without re-reading the full comment text. Plain text, comma-joined:
    // this is a handful of short tokens, not structured data anything
    // queries against, so JSONB would be unearned complexity here.
    matchedSignals: text('matched_signals').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by'),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('critical_incidents_business_created_idx').on(table.businessId, table.createdAt),
    // Backs the escalation sweep's WHERE acknowledgedAt IS NULL AND
    // escalatedAt IS NULL scan -- partial, since acknowledged/escalated
    // incidents (the overwhelming majority once the platform has been live
    // a while) never need to be found by that query again.
    index('critical_incidents_unacknowledged_idx')
      .on(table.businessId, table.createdAt)
      .where(sql`${table.acknowledgedAt} IS NULL`),
  ],
);
