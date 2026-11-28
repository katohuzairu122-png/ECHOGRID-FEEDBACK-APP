import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  foreignKey,
  index,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';

/**
 * SPLIT 09 block S9-A1 (development only, additive, nothing exposes it over HTTP). Implements owner ruling S9-D1:
 * B2B participation requires explicit PLATFORM enrollment plus the business's acceptance of B2B terms; a published
 * BDPN profile never confers participation. Per-block migration (S9-D12 / OD-24).
 *
 * Deliberately NOT modelled (owner decisions still open): partnership requests/limits (D3), approval (D4), grants (D5),
 * termination and retention (D6 - so there is no `left` status), messaging (D7), notifications (D9), moderation roles
 * (D10), plan gating (D11). No money, points, credits or customer data live here.
 *
 * `b2b_terms_versions` ships EMPTY: no B2B terms text is owner-approved, so enrollment fails closed until an owner-approved
 * version is activated by a separately authorized step.
 */
export const B2B_TERMS_STATES = ['draft', 'active', 'retired'] as const;
export type B2bTermsState = (typeof B2B_TERMS_STATES)[number];
export const B2B_PARTICIPATION_STATUSES = ['active', 'suspended', 'withdrawn'] as const;
export type B2bParticipationStatus = (typeof B2B_PARTICIPATION_STATUSES)[number];

export const b2bTermsVersions = pgTable(
  'b2b_terms_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version: text('version').notNull().unique(),
    termsDigest: text('terms_digest').notNull(),
    state: text('state').$type<B2bTermsState>().notNull().default('draft'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('b2b_terms_versions_digest_check', sql`${t.termsDigest} ~ '^[a-f0-9]{64}$'`),
    check('b2b_terms_versions_state_check', sql`${t.state} IN ('draft','active','retired')`),
    check(
      'b2b_terms_versions_active_effective_check',
      sql`${t.state} <> 'active' OR ${t.effectiveAt} IS NOT NULL`,
    ),
    uniqueIndex('b2b_terms_one_active_idx')
      .on(t.state)
      .where(sql`${t.state} = 'active'`),
  ],
);

export const b2bParticipations = pgTable(
  'b2b_participations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    status: text('status').$type<B2bParticipationStatus>().notNull().default('active'),
    termsVersionId: uuid('terms_version_id')
      .notNull()
      .references(() => b2bTermsVersions.id, { onDelete: 'restrict' }),
    termsDigest: text('terms_digest').notNull(),
    acceptedByUserId: uuid('accepted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    enrolledByUserId: uuid('enrolled_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedByUserId: uuid('suspended_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnByUserId: uuid('withdrawn_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('b2b_participations_business_key').on(t.businessId),
    uniqueIndex('b2b_participations_id_business_key').on(t.id, t.businessId),
    check(
      'b2b_participations_status_check',
      sql`${t.status} IN ('active','suspended','withdrawn')`,
    ),
    check('b2b_participations_digest_check', sql`${t.termsDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'b2b_participations_suspension_check',
      sql`(${t.status} = 'suspended') = (${t.suspendedAt} IS NOT NULL AND ${t.suspendedByUserId} IS NOT NULL)`,
    ),
    check(
      'b2b_participations_withdrawal_check',
      sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL AND ${t.withdrawnByUserId} IS NOT NULL)`,
    ),
  ],
);

export const b2bParticipationEvents = pgTable(
  'b2b_participation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participationId: uuid('participation_id').notNull(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'b2b_participation_events_participation_business_fk',
      columns: [t.participationId, t.businessId],
      foreignColumns: [b2bParticipations.id, b2bParticipations.businessId],
    }).onDelete('restrict'),
    index('b2b_participation_events_identity_idx').on(t.participationId, t.createdAt),
    index('b2b_participation_events_business_idx').on(t.businessId, t.createdAt),
    check(
      'b2b_participation_events_type_valid',
      sql`${t.eventType} IN ('enrolled','suspended','reinstated','withdrawn')`,
    ),
  ],
);
