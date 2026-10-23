import { pgTable, uuid, text, integer, bigint, timestamp, jsonb, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';
import { partnerCreditAwardDecisions } from './partner-credits';

/**
 * Split 07 disputed-award hold OVERLAY (migration 0050). INERT: every table is write-denied by its own guard (disposable databases only).
 *
 * The frozen award state machine (ineligible | cap_exceeded | provisional | vested | reversed) is NOT changed. A dispute is a separate, separately owned
 * record keyed to an award decision by the (id, business_id) tenant key. While a dispute is `open`, or `revoked` and not yet executed, the award is HELD:
 * the lifecycle and reservation services refuse to vest, expire or reserve it. Releasing the hold never edits the award; a revocation is recorded as an
 * approved PLAN only (no ledger entry is written here; execution is a separate, unauthorized financial stage).
 */
export const partnerCreditAwardDisputes = pgTable('partner_credit_award_disputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  decisionId: uuid('decision_id').notNull(),
  state: text('state').$type<'open' | 'released' | 'revoked'>().notNull().default('open'),
  revision: integer('revision').notNull().default(1),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  /** Approved, NOT executed plan for a revoked dispute. */
  plan: jsonb('plan').$type<Record<string, unknown>>(),
}, t => [
  unique('partner_credit_award_disputes_id_business_key').on(t.id, t.businessId),
  // At most one unresolved dispute per award at a time.
  uniqueIndex('partner_credit_award_disputes_open_key').on(t.decisionId).where(sql`${t.state} = 'open'`),
  index('partner_credit_award_disputes_decision_idx').on(t.decisionId, t.state),
  foreignKey({ name: 'partner_credit_award_disputes_decision_business_fk', columns: [t.decisionId, t.businessId], foreignColumns: [partnerCreditAwardDecisions.id, partnerCreditAwardDecisions.businessId] }).onDelete('restrict'),
  check('partner_credit_award_disputes_state_check', sql`${t.state} IN ('open','released','revoked')`),
  check('partner_credit_award_disputes_revision_check', sql`${t.revision} >= 1`),
  check('partner_credit_award_disputes_shape_check', sql`(${t.state} = 'open' AND ${t.resolvedAt} IS NULL AND ${t.plan} IS NULL)
    OR (${t.state} = 'released' AND ${t.resolvedAt} IS NOT NULL AND ${t.plan} IS NULL)
    OR (${t.state} = 'revoked' AND ${t.resolvedAt} IS NOT NULL AND ${t.plan} IS NOT NULL AND jsonb_typeof(${t.plan}) = 'object')`),
]);

/** Append-only evidence/decision trail with the acting platform administrator. Evidence is referenced, never stored inline. */
export const partnerCreditDisputeEvents = pgTable('partner_credit_dispute_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  disputeId: uuid('dispute_id').notNull(),
  businessId: uuid('business_id').notNull(),
  kind: text('kind').$type<'opened' | 'evidence_added' | 'resolved_upheld' | 'resolved_revoked'>().notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  actorPlatformRole: text('actor_platform_role').notNull(),
  evidenceRef: text('evidence_ref'),
  note: text('note'),
  dedupeKey: text('dedupe_key').notNull().unique(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  index('partner_credit_dispute_events_dispute_idx').on(t.disputeId, t.seq),
  foreignKey({ name: 'partner_credit_dispute_events_dispute_business_fk', columns: [t.disputeId, t.businessId], foreignColumns: [partnerCreditAwardDisputes.id, partnerCreditAwardDisputes.businessId] }).onDelete('restrict'),
  check('partner_credit_dispute_events_kind_check', sql`${t.kind} IN ('opened','evidence_added','resolved_upheld','resolved_revoked')`),
  check('partner_credit_dispute_events_role_check', sql`${t.actorPlatformRole} = 'admin'`),
  check('partner_credit_dispute_events_evidence_check', sql`${t.evidenceRef} IS NOT NULL AND btrim(${t.evidenceRef}) <> ''`),
  check('partner_credit_dispute_events_note_check', sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`),
]);

/**
 * Dual-control correction. A financial-impacting correction (revoking an award) is proposed by one platform administrator and decided by a DIFFERENT one;
 * the database itself refuses self-approval. Decided exactly once.
 */
export const partnerCreditCorrections = pgTable('partner_credit_corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  disputeId: uuid('dispute_id').notNull(),
  businessId: uuid('business_id').notNull(),
  kind: text('kind').$type<'revoke_award'>().notNull().default('revoke_award'),
  units: integer('units').notNull().default(1),
  state: text('state').$type<'proposed' | 'approved' | 'rejected'>().notNull().default('proposed'),
  proposedBy: uuid('proposed_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
}, t => [
  unique('partner_credit_corrections_dispute_kind_key').on(t.disputeId, t.kind),
  foreignKey({ name: 'partner_credit_corrections_dispute_business_fk', columns: [t.disputeId, t.businessId], foreignColumns: [partnerCreditAwardDisputes.id, partnerCreditAwardDisputes.businessId] }).onDelete('restrict'),
  check('partner_credit_corrections_kind_check', sql`${t.kind} = 'revoke_award'`),
  check('partner_credit_corrections_units_check', sql`${t.units} = 1`),
  check('partner_credit_corrections_state_check', sql`${t.state} IN ('proposed','approved','rejected')`),
  check('partner_credit_corrections_no_self_approval', sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.proposedBy}`),
  check('partner_credit_corrections_decided_check', sql`(${t.state} = 'proposed') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`),
  check('partner_credit_corrections_note_check', sql`${t.decisionNote} IS NULL OR char_length(${t.decisionNote}) <= 1000`),
]);
