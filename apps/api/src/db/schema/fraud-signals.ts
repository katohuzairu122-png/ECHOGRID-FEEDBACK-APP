import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { feedback } from './feedback';

/**
 * Append-only fraud/abuse detection log (Continuing Development spec S9.1's
 * "fraud signals, reason codes," S5's anti-fraud controls generally). One
 * row per finding a detector raises. Block 2's exact-duplicate-text check
 * predates this table and still records its finding directly on
 * `feedback.isDuplicateText` -- left as-is, not backfilled here. Every
 * detector from Continuing Development Block 3.2 onward (signed-QR-token
 * verification) and Block 4 (visit verification, device/IP velocity,
 * customer cooldown) writes here instead, so Block 5's fraud/review
 * consequences have one place to query "what's been flagged" across every
 * detector rather than a different shape per signal source.
 *
 * `feedbackId` is nullable and NOT unique, unlike critical_incidents'
 * feedbackId -- a signal isn't always about one specific feedback row (a
 * forged or expired QR token gets rejected before any feedback exists to
 * link to), and one feedback row can legitimately carry more than one
 * signal (duplicate text and a velocity breach are independent findings).
 *
 * `signalType`/`reasonCode` are deliberately open text, not a CHECK
 * constraint -- same reasoning as feedback.category: the full set of
 * detectors isn't designed yet (Blocks 3.2-5 each add more), and a closed
 * list today would force a migration every time a new detector ships.
 * `severity` and `status` ARE CHECK-constrained -- both are small, fully-
 * designed scales, same class as feedback.urgency/feedback.status.
 *
 * `status` is a text enum here rather than critical_incidents'
 * nullable-timestamp-as-marker pattern (acknowledgedAt/escalatedAt) on
 * purpose: critical_incidents models one linear yes/no progression, but a
 * signal branches to one of two distinct terminal outcomes (reviewed vs.
 * dismissed), which a single flag can't express -- this is the same shape
 * feedback.status (text + CHECK) already uses, not a new pattern.
 * `reviewedAt`/`reviewedBy` still capture the specific transition, mirroring
 * critical_incidents.acknowledgedAt/acknowledgedBy for "when/who."
 *
 * `metadata` is JSONB, unlike critical_incidents' plain-text
 * `matchedSignals` -- that column holds a handful of interchangeable
 * keyword tokens, while this one holds genuinely different shapes per
 * signalType (a velocity signal wants counts and a time window; a
 * token-signature signal wants which claim failed), which would otherwise
 * need a new nullable column per detector.
 *
 * No auditColumns/softDeleteColumns: this is an append-only detection log,
 * not staff-authored content -- a detector, not a named actor, creates
 * these rows (no meaningful `createdBy`), and nothing should be able to
 * make a fraud signal disappear, even softly, without that itself being
 * auditable as a status change (`dismissed`), not a deletion.
 */
export const fraudSignals = pgTable(
  'fraud_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'cascade' }),
    signalType: text('signal_type').notNull(),
    reasonCode: text('reason_code').notNull(),
    severity: text('severity').notNull().default('low'),
    status: text('status').notNull().default('open'),
    metadata: jsonb('metadata'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    // Plain nullable UUID, no FK to `users` -- matches auditColumns'
    // createdBy/updatedBy convention elsewhere in this schema: metadata,
    // not relational integrity.
    reviewedBy: uuid('reviewed_by'),
  },
  (table) => [
    index('fraud_signals_business_branch_detected_idx').on(table.businessId, table.branchId, table.detectedAt),
    // Backs the "open signals" queue Block 5's manual-review routing reads
    // from -- partial, same reasoning as feedback_critical_idx and
    // critical_incidents_unacknowledged_idx: open signals are the small,
    // actionable minority once a signal has actually been triaged.
    index('fraud_signals_business_open_idx')
      .on(table.businessId, table.detectedAt)
      .where(sql`${table.status} = 'open'`),
    // Backs FraudSignalRepository.findByFeedbackId -- partial for the same
    // reason as feedback_duplicate_hash_idx: most feedback rows never have
    // a signal at all, so indexing every NULL would waste space for zero
    // query benefit.
    index('fraud_signals_feedback_idx').on(table.feedbackId).where(sql`${table.feedbackId} IS NOT NULL`),
    check('fraud_signals_severity_check', sql`${table.severity} IN ('low', 'medium', 'high')`),
    check('fraud_signals_status_check', sql`${table.status} IN ('open', 'reviewed', 'dismissed')`),
  ],
);
