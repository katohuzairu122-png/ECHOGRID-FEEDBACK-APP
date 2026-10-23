import { pgTable, uuid, text, integer, bigint, boolean, timestamp, jsonb, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { partnerCreditReservations } from './partner-credit-applications';

/**
 * Split 08 durable benefit-application saga (migration 0048). INERT: every table carries a write-denial guard (like 0042); only an isolated
 * disposable database may disable it. Persists the workflow state of ONE Partner Credit reservation being applied to ONE invoice, the provider
 * attempt, the append-only provider observations and compensations, and an append-only transition log.
 *
 * It does NOT mutate lots, accounts, the ledger, reservations or the applications table: the terminal consumption transaction is a separate,
 * unauthorized stage. A saga row in state `consumed` records that a verified provider effect was reconciled; it is not a credit movement.
 * Tenant keys are database-enforced: every child row carries (intent_id, business_id) as a composite foreign key.
 */
export const benefitApplicationIntents = pgTable('benefit_application_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  reservationId: uuid('reservation_id').notNull(),
  invoiceRef: text('invoice_ref').notNull(),
  units: integer('units').notNull().default(1),
  expectedBenefitMinor: integer('expected_benefit_minor').notNull(),
  currency: text('currency').notNull(),
  policyVersion: text('policy_version').notNull(),
  state: text('state').$type<'reserved' | 'applying' | 'retained' | 'consumed' | 'released'>().notNull().default('reserved'),
  /** Business-facing explicit outcome derived from state and cause. */
  outcome: text('outcome').$type<'pending' | 'confirmed' | 'rejected' | 'disputed' | 'unresolved'>().notNull().default('pending'),
  attemptKey: text('attempt_key'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  cause: text('cause'),
  /** Reversal references received while the provider outcome was unknown; compensated if the effect is later confirmed. */
  pendingReversalRefs: jsonb('pending_reversal_refs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  providerEffectRef: text('provider_effect_ref'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('benefit_application_intents_reservation_key').on(t.reservationId),
  unique('benefit_application_intents_id_business_key').on(t.id, t.businessId),
  // One provider effect can settle exactly one reservation, in any business.
  uniqueIndex('benefit_application_intents_effect_key').on(t.providerEffectRef).where(sql`${t.providerEffectRef} IS NOT NULL`),
  index('benefit_application_intents_state_idx').on(t.state, t.updatedAt),
  foreignKey({ name: 'benefit_application_intents_reservation_business_fk', columns: [t.reservationId, t.businessId], foreignColumns: [partnerCreditReservations.id, partnerCreditReservations.businessId] }).onDelete('restrict'),
  check('benefit_application_intents_units_check', sql`${t.units} = 1`),
  check('benefit_application_intents_benefit_check', sql`${t.expectedBenefitMinor} > 0`),
  check('benefit_application_intents_currency_check', sql`${t.currency} ~ '^[a-z]{3}$'`),
  check('benefit_application_intents_state_check', sql`${t.state} IN ('reserved','applying','retained','consumed','released')`),
  check('benefit_application_intents_outcome_check', sql`${t.outcome} IN ('pending','confirmed','rejected','disputed','unresolved')`),
  check('benefit_application_intents_version_check', sql`${t.version} >= 1`),
  check('benefit_application_intents_pending_array_check', sql`jsonb_typeof(${t.pendingReversalRefs}) = 'array'`),
  check('benefit_application_intents_shape_check', sql`(
    (${t.state} = 'reserved' AND ${t.attemptKey} IS NULL AND ${t.cause} IS NULL AND ${t.providerEffectRef} IS NULL AND ${t.appliedAt} IS NULL AND ${t.outcome} = 'pending')
    OR (${t.state} = 'applying' AND ${t.attemptKey} IS NOT NULL AND ${t.attemptedAt} IS NOT NULL AND ${t.cause} IS NULL AND ${t.providerEffectRef} IS NULL AND ${t.appliedAt} IS NULL AND ${t.outcome} = 'pending')
    OR (${t.state} = 'retained' AND ${t.attemptKey} IS NOT NULL AND ${t.attemptedAt} IS NOT NULL AND ${t.cause} IS NOT NULL AND ${t.providerEffectRef} IS NULL AND ${t.appliedAt} IS NULL AND ${t.outcome} IN ('disputed','unresolved'))
    OR (${t.state} = 'consumed' AND ${t.attemptKey} IS NOT NULL AND ${t.providerEffectRef} IS NOT NULL AND ${t.appliedAt} IS NOT NULL AND ${t.cause} IS NULL AND ${t.outcome} = 'confirmed')
    OR (${t.state} = 'released' AND ${t.cause} IS NOT NULL AND ${t.providerEffectRef} IS NULL AND ${t.appliedAt} IS NULL AND ${t.outcome} = 'rejected'))`),
]);

/** One provider attempt per reservation (a second attempt for one reservation is refused by the database as well as by the saga). */
export const benefitProviderAttempts = pgTable('benefit_provider_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  intentId: uuid('intent_id').notNull(),
  businessId: uuid('business_id').notNull(),
  attemptKey: text('attempt_key').notNull(),
  /** Stable key sent to the provider so a retry can never apply the benefit twice. */
  providerIdempotencyKey: text('provider_idempotency_key').notNull().unique(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  uniqueIndex('benefit_provider_attempts_intent_key').on(t.intentId),
  unique('benefit_provider_attempts_intent_attempt_key').on(t.intentId, t.attemptKey),
  foreignKey({ name: 'benefit_provider_attempts_intent_business_fk', columns: [t.intentId, t.businessId], foreignColumns: [benefitApplicationIntents.id, benefitApplicationIntents.businessId] }).onDelete('restrict'),
]);

/** Append-only record of every provider read (a digest only; never the provider payload, a credential or a card/customer field). */
export const benefitProviderObservations = pgTable('benefit_provider_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  intentId: uuid('intent_id').notNull(),
  businessId: uuid('business_id').notNull(),
  attemptKey: text('attempt_key').notNull(),
  status: text('status').$type<'effect_present' | 'effect_absent' | 'unreachable'>().notNull(),
  classification: text('classification').$type<'matched' | 'mismatch' | 'unattributed' | 'absent_confirmed' | 'absent_stale' | 'unreachable'>().notNull(),
  effectRef: text('effect_ref'),
  amountMinor: integer('amount_minor'),
  currency: text('currency'),
  invoiceRef: text('invoice_ref'),
  attributedReservationRef: text('attributed_reservation_ref'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  payloadDigest: text('payload_digest').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  uniqueIndex('benefit_provider_observations_digest_key').on(t.intentId, t.attemptKey, t.payloadDigest),
  index('benefit_provider_observations_intent_idx').on(t.intentId, t.recordedAt),
  foreignKey({ name: 'benefit_provider_observations_intent_business_fk', columns: [t.intentId, t.businessId], foreignColumns: [benefitApplicationIntents.id, benefitApplicationIntents.businessId] }).onDelete('restrict'),
  check('benefit_provider_observations_status_check', sql`${t.status} IN ('effect_present','effect_absent','unreachable')`),
  check('benefit_provider_observations_class_check', sql`${t.classification} IN ('matched','mismatch','unattributed','absent_confirmed','absent_stale','unreachable')`),
  check('benefit_provider_observations_digest_check', sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
  check('benefit_provider_observations_shape_check', sql`(${t.status} = 'effect_present' AND ${t.effectRef} IS NOT NULL AND ${t.amountMinor} IS NOT NULL AND ${t.amountMinor} >= 0 AND ${t.currency} IS NOT NULL AND ${t.invoiceRef} IS NOT NULL AND ${t.classification} IN ('matched','mismatch','unattributed'))
    OR (${t.status} = 'effect_absent' AND ${t.effectRef} IS NULL AND ${t.classification} IN ('absent_confirmed','absent_stale'))
    OR (${t.status} = 'unreachable' AND ${t.effectRef} IS NULL AND ${t.classification} = 'unreachable')`),
]);

/** Append-only compensating entries: history is never edited; one negative entry per reversal reference. */
export const benefitApplicationCompensations = pgTable('benefit_application_compensations', {
  id: uuid('id').primaryKey().defaultRandom(),
  intentId: uuid('intent_id').notNull(),
  businessId: uuid('business_id').notNull(),
  reversalRef: text('reversal_ref').notNull(),
  units: integer('units').notNull(),
  benefitMinor: integer('benefit_minor').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  uniqueIndex('benefit_application_compensations_reversal_key').on(t.intentId, t.reversalRef),
  foreignKey({ name: 'benefit_application_compensations_intent_business_fk', columns: [t.intentId, t.businessId], foreignColumns: [benefitApplicationIntents.id, benefitApplicationIntents.businessId] }).onDelete('restrict'),
  check('benefit_application_compensations_negative_check', sql`${t.units} < 0 AND ${t.benefitMinor} < 0`),
]);

/** Append-only audit of every accepted transition (including idempotent replays, flagged), with the declarative effects it produced. */
export const benefitApplicationTransitions = pgTable('benefit_application_transitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  intentId: uuid('intent_id').notNull(),
  businessId: uuid('business_id').notNull(),
  eventType: text('event_type').notNull(),
  fromState: text('from_state').notNull(),
  toState: text('to_state').notNull(),
  replay: boolean('replay').notNull(),
  attemptKey: text('attempt_key'),
  effects: jsonb('effects').$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  index('benefit_application_transitions_intent_seq_idx').on(t.intentId, t.seq),
  foreignKey({ name: 'benefit_application_transitions_intent_business_fk', columns: [t.intentId, t.businessId], foreignColumns: [benefitApplicationIntents.id, benefitApplicationIntents.businessId] }).onDelete('restrict'),
  check('benefit_application_transitions_event_check', sql`${t.eventType} IN ('begin_apply','provider_observation','reverse','release_unused')`),
  check('benefit_application_transitions_effects_check', sql`jsonb_typeof(${t.effects}) = 'array'`),
]);
