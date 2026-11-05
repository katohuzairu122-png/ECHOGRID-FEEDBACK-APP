import { pgTable, uuid, text, bigint, timestamp, unique, check, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { partnerCreditReservations } from './partner-credit-applications';

/**
 * S08-D1D3-DEV-03: durable, append-only SETTLEMENT AUTHORIZATION evidence (migration 0060). INERT like the other Split 08 evidence tables: an insert guard denies
 * writes outside an isolated disposable database, and no route, queue or cron writes here.
 *
 * One row records what the pure settlement classifier concluded about ONE reservation from ONE evidence snapshot. It binds the business, reservation, decision,
 * invoice, Stripe account and mode, the frozen allocation digest and the snapshot. `evidence_digest` is recomputed by the database from the other columns, so a row
 * cannot be edited or forged without matching it. It is evidence, not a financial movement: it moves no lot, account, reservation or ledger row.
 *
 * Development limit: `evidence_kind` is only ever MOCK_SYNTHETIC until the Stripe evidence questions (Q1/Q2) are authorized. A database writer with INSERT
 * privilege can still write a row whose verdict the classifier never computed (no MAC key exists); role hardening (finding F-5) is what restricts that.
 */
export const partnerCreditSettlementAuthorizations = pgTable('partner_credit_settlement_authorizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  reservationId: uuid('reservation_id').notNull(),
  decisionId: uuid('decision_id').notNull(),
  invoiceRef: text('invoice_ref').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  providerMode: text('provider_mode').$type<'test' | 'live'>().notNull(),
  allocationDigest: text('allocation_digest').notNull(),
  policyVersion: text('policy_version').notNull(),
  verdict: text('verdict').$type<'ELIGIBLE' | 'INELIGIBLE' | 'UNRESOLVED'>().notNull(),
  reasonCodes: text('reason_codes').array().notNull(),
  classifierVersion: text('classifier_version').notNull(),
  evidenceKind: text('evidence_kind').notNull(),
  billingInterval: text('billing_interval').$type<'month' | 'year' | 'unknown'>().notNull(),
  snapshotRef: text('snapshot_ref').notNull(),
  snapshotDigest: text('snapshot_digest').notNull(),
  observedAtMs: bigint('observed_at_ms', { mode: 'number' }).notNull(),
  evidenceDigest: text('evidence_digest').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  unique('partner_credit_settlement_auth_replay_key').on(t.reservationId, t.snapshotDigest),
  foreignKey({ name: 'partner_credit_settlement_auth_reservation_fk', columns: [t.reservationId, t.businessId], foreignColumns: [partnerCreditReservations.id, partnerCreditReservations.businessId] }).onDelete('restrict'),
  index('partner_credit_settlement_auth_latest_idx').on(t.reservationId, t.observedAtMs, t.recordedAt, t.id),
  check('partner_credit_settlement_auth_provider_mode_check', sql`${t.providerMode} IN ('test','live')`),
  check('partner_credit_settlement_auth_verdict_check', sql`${t.verdict} IN ('ELIGIBLE','INELIGIBLE','UNRESOLVED')`),
  check('partner_credit_settlement_auth_interval_check', sql`${t.billingInterval} IN ('month','year','unknown')`),
  check('partner_credit_settlement_auth_evidence_kind_check', sql`${t.evidenceKind} = 'MOCK_SYNTHETIC'`),
  check('partner_credit_settlement_auth_digests_check', sql`${t.allocationDigest} ~ '^[0-9a-f]{64}$' AND ${t.snapshotDigest} ~ '^[0-9a-f]{64}$' AND ${t.evidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check('partner_credit_settlement_auth_refs_check', sql`${t.invoiceRef} ~ '^[!-~]{1,255}$' AND ${t.providerAccountId} ~ '^[!-~]{1,255}$' AND ${t.policyVersion} ~ '^[!-~]{1,255}$' AND ${t.classifierVersion} ~ '^[!-~]{1,255}$' AND ${t.snapshotRef} ~ '^[!-~]{1,255}$'`),
  check('partner_credit_settlement_auth_observed_check', sql`${t.observedAtMs} > 0`),
  check('partner_credit_settlement_auth_reasons_check', sql`cardinality(${t.reasonCodes}) >= 1 AND array_to_string(${t.reasonCodes}, ',') ~ '^[A-Z_]+(,[A-Z_]+)*$'`),
  check('partner_credit_settlement_auth_verdict_reason_check', sql`(${t.verdict} = 'ELIGIBLE' AND ${t.reasonCodes} = ARRAY['ALL_CONDITIONS_VERIFIED']::text[]) OR (${t.verdict} <> 'ELIGIBLE' AND NOT ('ALL_CONDITIONS_VERIFIED' = ANY(${t.reasonCodes})))`),
]);
