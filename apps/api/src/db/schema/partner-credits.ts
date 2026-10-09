import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';
import { orphanSettlements } from './orphan-settlement';

/** SPLIT 07 Block 1: inert foundations. No executable mint/redeem path. */
export const partnerProgramEnrollments = pgTable('partner_program_enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  status: text('status').$type<'active' | 'suspended' | 'left'>().notNull(),
  policyVersion: text('policy_version').notNull(),
  acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
}, t => [
  uniqueIndex('partner_enrollments_business_key').on(t.businessId),
  check('partner_enrollments_status_check', sql`${t.status} IN ('active','suspended','left')`),
]);

export const partnerCreditPolicies = pgTable('partner_credit_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: text('version').notNull().unique(),
  state: text('state').$type<'draft' | 'active' | 'retired'>().notNull().default('draft'),
  awardUnits: integer('award_units').notNull().default(1),
  monthlyCap: integer('monthly_cap').notNull().default(10),
  vestDays: integer('vest_days').notNull().default(14),
  expiresAfterMonths: integer('expires_after_months').notNull().default(12),
  effectiveAt: timestamp('effective_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('partner_credit_policies_positive_check', sql`${t.awardUnits} > 0 AND ${t.monthlyCap} > 0 AND ${t.vestDays} > 0 AND ${t.expiresAfterMonths} > 0`),
  check('partner_credit_policies_status_check', sql`${t.state} IN ('draft','active','retired')`),
  uniqueIndex('partner_credit_one_active_policy_idx').on(t.state).where(sql`${t.state} = 'active'`),
]);

export const partnerCreditAccounts = pgTable('partner_credit_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  available: integer('available').notNull().default(0),
  provisional: integer('provisional').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  recoveryDue: integer('recovery_due').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('partner_credit_accounts_business_key').on(t.businessId),
  check('partner_credit_account_nonnegative_check', sql`${t.available} >= 0 AND ${t.provisional} >= 0 AND ${t.reserved} >= 0 AND ${t.recoveryDue} >= 0`),
]);

export const partnerCreditAwardDecisions = pgTable('partner_credit_award_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  settlementRef: uuid('settlement_ref').notNull().references(() => orphanSettlements.id, { onDelete: 'restrict' }),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  policyId: uuid('policy_id').notNull().references(() => partnerCreditPolicies.id, { onDelete: 'restrict' }),
  state: text('state').$type<'ineligible' | 'cap_exceeded' | 'provisional' | 'vested' | 'reversed'>().notNull(),
  awardUnits: integer('award_units').notNull(),
  earningMonthUtc: text('earning_month_utc').notNull(),
  fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }).notNull(),
  vestAt: timestamp('vest_at', { withTimezone: true }),
  idempotencyKey: text('idempotency_key').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('partner_credit_awards_settlement_key').on(t.settlementRef),
  uniqueIndex('partner_credit_awards_idempotency_key').on(t.idempotencyKey),
  index('partner_credit_awards_business_month_idx').on(t.businessId,t.earningMonthUtc),
  check('partner_credit_awards_units_check', sql`${t.awardUnits} >= 0`),
  check('partner_credit_awards_month_check', sql`${t.earningMonthUtc} ~ '^[0-9]{4}-[0-9]{2}$'`),
  check('partner_credit_awards_status_check', sql`${t.state} IN ('ineligible','cap_exceeded','provisional','vested','reversed')`),
]);

export const partnerCreditLots = pgTable('partner_credit_lots', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').notNull().references(() => partnerCreditAwardDecisions.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').notNull().references(() => partnerCreditAccounts.id, { onDelete: 'restrict' }),
  units: integer('units').notNull(),
  availableUnits: integer('available_units').notNull().default(0),
  status: text('status').$type<'provisional'|'available'|'reserved'|'consumed'|'expired'|'reversed'>().notNull(),
  vestAt: timestamp('vest_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, t => [
  uniqueIndex('partner_credit_lots_decision_key').on(t.decisionId),
  check('partner_credit_lots_units_check', sql`${t.units} > 0 AND ${t.availableUnits} >= 0 AND ${t.availableUnits} <= ${t.units}`),
  check('partner_credit_lots_state_check', sql`${t.status} IN ('provisional','available','reserved','consumed','expired','reversed')`),
]);

export const partnerCreditLedger = pgTable('partner_credit_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => partnerCreditAccounts.id, { onDelete: 'restrict' }),
  decisionId: uuid('decision_id').references(() => partnerCreditAwardDecisions.id, { onDelete: 'restrict' }),
  entryType: text('entry_type').$type<'provisional'|'vest'|'expire'|'reverse'|'recovery_offset'|'admin_adjustment'>().notNull(),
  units: integer('units').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('partner_credit_ledger_idempotency_key').on(t.idempotencyKey),
  index('partner_credit_ledger_account_date_idx').on(t.accountId,t.occurredAt),
  check('partner_credit_ledger_nonzero_check', sql`${t.units} <> 0`),
  check('partner_credit_ledger_type_check', sql`${t.entryType} IN ('provisional','vest','expire','reverse','recovery_offset','admin_adjustment')`),
]);

export const partnerCreditRecoveryObligations = pgTable('partner_credit_recovery_obligations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => partnerCreditAccounts.id, { onDelete: 'restrict' }),
  reversalRef: uuid('reversal_ref').notNull().unique(),
  unitsDue: integer('units_due').notNull(),
  unitsOutstanding: integer('units_outstanding').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('partner_credit_recovery_units_check', sql`${t.unitsDue} > 0 AND ${t.unitsOutstanding} >= 0 AND ${t.unitsOutstanding} <= ${t.unitsDue}`),
]);
