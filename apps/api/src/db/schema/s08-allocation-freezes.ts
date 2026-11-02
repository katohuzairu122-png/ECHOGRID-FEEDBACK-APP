import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  jsonb,
  boolean,
  timestamp,
  unique,
  foreignKey,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { businesses } from './businesses';
import { partnerCreditReservations } from './partner-credit-applications';

/** Immutable integrity evidence only. Migration 0052 denies every mutation,
 * including TRUNCATE. No authorized append path or financial authority. */
export const s08AllocationFreezes = pgTable(
  's08_allocation_freezes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    invoiceRef: text('invoice_ref').notNull(),
    currency: text('currency').notNull(),
    policyVersion: text('policy_version').notNull(),
    allocationDigest: text('allocation_digest').notNull(),
    aggregateBenefitMinor: bigint('aggregate_benefit_minor', { mode: 'bigint' }).notNull(),
    reservationCount: integer('reservation_count').notNull(),
    artifact: jsonb('artifact').$type<Record<string, unknown>>().notNull(),
    providerVerified: boolean('provider_verified').notNull().default(false),
    consumptionAuthorized: boolean('consumption_authorized').notNull().default(false),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique('s08_allocation_freezes_business_id_invoice_ref_key').on(t.businessId, t.invoiceRef),
    unique('s08_allocation_freezes_id_business_id_key').on(t.id, t.businessId),
    check('s08_allocation_freezes_currency_check', sql`${t.currency} ~ '^[a-z]{3}$'`),
    check(
      's08_allocation_freezes_policy_version_check',
      sql`${t.policyVersion} = 'S08-AGG-ROUND/1'`,
    ),
    check(
      's08_allocation_freezes_allocation_digest_check',
      sql`${t.allocationDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      's08_allocation_freezes_aggregate_benefit_minor_check',
      sql`${t.aggregateBenefitMinor} > 0`,
    ),
    check(
      's08_allocation_freezes_reservation_count_check',
      sql`${t.reservationCount} BETWEEN 1 AND 10`,
    ),
    check('s08_allocation_freezes_artifact_check', sql`jsonb_typeof(${t.artifact}) = 'object'`),
    check('s08_allocation_freezes_provider_verified_check', sql`${t.providerVerified} = false`),
    check(
      's08_allocation_freezes_consumption_authorized_check',
      sql`${t.consumptionAuthorized} = false`,
    ),
  ],
);

export const s08AllocationFreezeItems = pgTable(
  's08_allocation_freeze_items',
  {
    freezeId: uuid('freeze_id').notNull(),
    businessId: uuid('business_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    invoiceIntentRef: text('invoice_intent_ref').notNull(),
    benefitMinor: bigint('benefit_minor', { mode: 'bigint' }).notNull(),
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.freezeId, t.reservationId] }),
    unique('s08_allocation_freeze_items_reservation_id_key').on(t.reservationId),
    unique('s08_allocation_freeze_items_provider_idempotency_key_key').on(t.providerIdempotencyKey),
    foreignKey({
      columns: [t.freezeId, t.businessId],
      foreignColumns: [s08AllocationFreezes.id, s08AllocationFreezes.businessId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.reservationId, t.businessId],
      foreignColumns: [partnerCreditReservations.id, partnerCreditReservations.businessId],
    }).onDelete('restrict'),
    check('s08_allocation_freeze_items_benefit_minor_check', sql`${t.benefitMinor} > 0`),
  ],
);
