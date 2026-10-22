import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index, check, unique, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { businessSubscriptions } from './business-subscriptions';
import { partnerCreditAccounts, partnerCreditAwardDecisions, partnerCreditLots } from './partner-credits';

/** Mirrors SQL-only migration 0042. Inert triggers remain authoritative. */
export const partnerCreditReservations = pgTable('partner_credit_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  decisionId: uuid('decision_id').notNull().references(() => partnerCreditAwardDecisions.id, { onDelete: 'restrict' }),
  lotId: uuid('lot_id').notNull().references(() => partnerCreditLots.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').notNull().references(() => partnerCreditAccounts.id, { onDelete: 'restrict' }),
  invoiceIntentRef: text('invoice_intent_ref').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  units: integer('units').notNull().default(1),
  state: text('state').$type<'reserved' | 'released' | 'consumed'>().notNull().default('reserved'),
  expiresAt: timestamp('expires_at', { withTimezone:true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone:true }).notNull().defaultNow(),
  terminalAt: timestamp('terminal_at', { withTimezone:true }),
}, t => [
  uniqueIndex('partner_credit_reservations_lot_key').on(t.lotId),
  unique('partner_credit_reservations_id_business_key').on(t.id, t.businessId),
  // Tenant-key equality is enforced by the database, not only by the read-side verifier: the decision and the account must
  // belong to the reservation's business, and the lot must belong to exactly that decision and account.
  foreignKey({ name: 'partner_credit_reservations_decision_business_fk', columns: [t.decisionId, t.businessId], foreignColumns: [partnerCreditAwardDecisions.id, partnerCreditAwardDecisions.businessId] }).onDelete('restrict'),
  foreignKey({ name: 'partner_credit_reservations_account_business_fk', columns: [t.accountId, t.businessId], foreignColumns: [partnerCreditAccounts.id, partnerCreditAccounts.businessId] }).onDelete('restrict'),
  foreignKey({ name: 'partner_credit_reservations_lot_decision_account_fk', columns: [t.lotId, t.decisionId, t.accountId], foreignColumns: [partnerCreditLots.id, partnerCreditLots.decisionId, partnerCreditLots.accountId] }).onDelete('restrict'),
  uniqueIndex('partner_credit_reservations_invoice_intent_key').on(t.businessId,t.invoiceIntentRef),
  index('partner_credit_reservations_business_state_idx').on(t.businessId,t.state),
  check('partner_credit_reservations_units_check',sql`${t.units} = 1`),
  check('partner_credit_reservations_state_check',sql`${t.state} IN ('reserved','released','consumed')`),
  check('partner_credit_reservations_terminal_consistency',sql`(${t.state} = 'reserved' AND ${t.terminalAt} IS NULL) OR (${t.state} IN ('released','consumed') AND ${t.terminalAt} IS NOT NULL)`),
]);

/** A row alone is NOT proof of provider-authoritative billing success. */
export const billingPartnerCreditApplications = pgTable('billing_partner_credit_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  reservationId: uuid('reservation_id').notNull().unique().references(() => partnerCreditReservations.id,{onDelete:'restrict'}),
  businessId: uuid('business_id').notNull().references(() => businesses.id,{onDelete:'restrict'}),
  subscriptionId: uuid('subscription_id').notNull().references(() => businessSubscriptions.id,{onDelete:'restrict'}),
  invoiceRef: text('invoice_ref').notNull(),
  providerSuccessRef: text('provider_success_ref').notNull().unique(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  unitsApplied: integer('units_applied').notNull(),
  terminalState: text('terminal_state').$type<'applied'>().notNull(),
  appliedAt: timestamp('applied_at',{withTimezone:true}).notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
}, t => [
  uniqueIndex('billing_partner_credit_applications_invoice_once').on(t.businessId,t.invoiceRef),
  foreignKey({ name: 'billing_partner_credit_applications_reservation_business_fk', columns: [t.reservationId, t.businessId], foreignColumns: [partnerCreditReservations.id, partnerCreditReservations.businessId] }).onDelete('restrict'),
  foreignKey({ name: 'billing_partner_credit_applications_subscription_business_fk', columns: [t.subscriptionId, t.businessId], foreignColumns: [businessSubscriptions.id, businessSubscriptions.businessId] }).onDelete('restrict'),
  index('billing_partner_credit_applications_subscription_idx').on(t.subscriptionId,t.appliedAt),
  check('billing_partner_credit_applications_units_check',sql`${t.unitsApplied} = 1`),
  check('billing_partner_credit_applications_terminal_check',sql`${t.terminalState} = 'applied'`),
]);
