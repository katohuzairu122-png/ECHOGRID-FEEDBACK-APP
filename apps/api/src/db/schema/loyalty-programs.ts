import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { customers } from './customers';
import { loyaltyAccounts } from './loyalty-accounts';
import { loyaltyRewards } from './loyalty-rewards';
import { loyaltyPurchaseEvents } from './loyalty-purchase-events';
import {
  LOYALTY_PROGRAM_STATUSES,
  LOYALTY_PROGRAM_TYPES,
  type LoyaltyProgramStatus,
  type LoyaltyProgramType,
} from '@echo-grid-feedback/shared-types';

/**
 * LOYALTY-PROGRAMME-COMPLETION, Group 01 (REWARD-CONFIG-01 sections 3.1 to 3.6, rulings RW-D1 to RW-D5).
 *
 * How a customer EARNS is the business's PRIMARY loyalty programme (LP-01..LP-08). It is distinct from tiers (membership levels),
 * redeemable rewards (RW-01..RW-04), promotional overlays, Community Points, Tentaship Badges, Shuffle and Drops, none of which share a
 * balance with it. A business has at most ONE active primary programme, enforced by a partial unique index and a transition guard.
 *
 * Immutability: a programme's configuration lives in append-only VERSIONS. Editing an active programme writes a new version that
 * applies to FUTURE events only; every programme-generated ledger or progress row records the programme and version it used.
 */
export const LOYALTY_PROGRAM_EVENT_TYPES = [
  'created',
  'version_created',
  'validated',
  'activated',
  'deactivated',
  'retired',
  'switched_to',
  'switched_from',
  'legacy_backfill',
] as const;

const typeList = LOYALTY_PROGRAM_TYPES.map((t) => `'${t}'`).join(',');
const statusList = LOYALTY_PROGRAM_STATUSES.map((s) => `'${s}'`).join(',');

export const loyaltyPrograms = pgTable(
  'loyalty_programs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    type: text('type').$type<LoyaltyProgramType>().notNull(),
    status: text('status').$type<LoyaltyProgramStatus>().notNull().default('draft'),
    currentVersion: integer('current_version').notNull().default(1),
    /** True only for the programme backfilled from a pre-programme business: it reproduces that business's existing earning exactly. */
    legacy: boolean('legacy').notNull().default(false),
    createdBy: uuid('created_by'),
    activatedBy: uuid('activated_by'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // RW-D1: at most one active primary programme per business, enforced by the database.
    uniqueIndex('loyalty_programs_one_active_per_business').on(table.businessId).where(sql`${table.status} = 'active'`),
    uniqueIndex('loyalty_programs_id_business_uq').on(table.id, table.businessId),
    index('loyalty_programs_business_status_idx').on(table.businessId, table.status),
    check('loyalty_programs_type_check', sql.raw(`"loyalty_programs"."type" IN (${typeList})`)),
    check('loyalty_programs_status_check', sql.raw(`"loyalty_programs"."status" IN (${statusList})`)),
    check('loyalty_programs_version_check', sql`${table.currentVersion} >= 1`),
    // LP-08 needs verified item-level purchase evidence that does not exist yet (RW-D3): it can never be activated.
    check('loyalty_programs_lp08_not_activatable', sql`${table.status} <> 'active' OR ${table.type} <> 'LP-08'`),
  ],
);

export const loyaltyProgramVersions = pgTable(
  'loyalty_program_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id').notNull(),
    businessId: uuid('business_id').notNull(),
    version: integer('version').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    configHash: text('config_hash').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.programId, table.businessId], foreignColumns: [loyaltyPrograms.id, loyaltyPrograms.businessId], name: 'loyalty_program_versions_program_business_fk' }).onDelete('restrict'),
    uniqueIndex('loyalty_program_versions_program_version_uq').on(table.programId, table.version),
    check('loyalty_program_versions_version_check', sql`${table.version} >= 1`),
    check('loyalty_program_versions_config_object', sql`jsonb_typeof(${table.config}) = 'object' AND pg_column_size(${table.config}) <= 65536`),
  ],
);

export const loyaltyProgramEvents = pgTable(
  'loyalty_program_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    programId: uuid('program_id').notNull(),
    eventType: text('event_type').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    version: integer('version'),
    actorUserId: uuid('actor_user_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.programId, table.businessId], foreignColumns: [loyaltyPrograms.id, loyaltyPrograms.businessId], name: 'loyalty_program_events_program_business_fk' }).onDelete('restrict'),
    index('loyalty_program_events_program_idx').on(table.programId, table.createdAt),
    check('loyalty_program_events_type_check', sql.raw(`"loyalty_program_events"."event_type" IN (${LOYALTY_PROGRAM_EVENT_TYPES.map((t) => `'${t}'`).join(',')})`)),
  ],
);

/** A business with no explicit setup row and no programme earns under the implicit legacy rule; 'pending' or 'configured' means the owner chose a path. */
export const loyaltyProgramSetup = pgTable(
  'loyalty_program_setup',
  {
    businessId: uuid('business_id').primaryKey().references(() => businesses.id, { onDelete: 'restrict' }),
    state: text('state').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('loyalty_program_setup_state_check', sql`${table.state} IN ('pending','configured')`)],
);

/** One progress record per customer account per programme (stamps, streak, mission or milestone counters). Never mixes into the points ledger. */
export const loyaltyProgramProgress = pgTable(
  'loyalty_program_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    programId: uuid('program_id').notNull(),
    loyaltyAccountId: uuid('loyalty_account_id').notNull().references(() => loyaltyAccounts.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    /** Counters named by the programme type (for example stamps, cycle, streak, lastPeriod). Updated only under the row lock. */
    counters: jsonb('counters').$type<Record<string, unknown>>().notNull().default({}),
    /** Set when the programme stops being active: the counters are frozen and never converted (RW-D2). */
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.programId, table.businessId], foreignColumns: [loyaltyPrograms.id, loyaltyPrograms.businessId], name: 'loyalty_program_progress_program_business_fk' }).onDelete('restrict'),
    uniqueIndex('loyalty_program_progress_program_account_uq').on(table.programId, table.loyaltyAccountId),
    index('loyalty_program_progress_account_idx').on(table.loyaltyAccountId),
  ],
);

/** Append-only history of every progress change. The unique source key makes a replayed event a no-op (duplicate prevention). */
export const loyaltyProgramProgressEvents = pgTable(
  'loyalty_program_progress_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    progressId: uuid('progress_id').notNull().references(() => loyaltyProgramProgress.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id').notNull(),
    programId: uuid('program_id').notNull(),
    programVersion: integer('program_version').notNull(),
    loyaltyAccountId: uuid('loyalty_account_id').notNull().references(() => loyaltyAccounts.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    delta: integer('delta').notNull(),
    countersAfter: jsonb('counters_after').$type<Record<string, unknown>>().notNull(),
    purchaseEventId: uuid('purchase_event_id').references(() => loyaltyPurchaseEvents.id, { onDelete: 'restrict' }),
    /** Deterministic key of the thing this entry accounts for (a purchase event, a cycle, a milestone). Unique per programme. */
    sourceKey: text('source_key').notNull(),
    reversesEventId: uuid('reverses_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.programId, table.businessId], foreignColumns: [loyaltyPrograms.id, loyaltyPrograms.businessId], name: 'loyalty_program_progress_events_program_business_fk' }).onDelete('restrict'),
    uniqueIndex('loyalty_program_progress_events_source_uq').on(table.programId, table.sourceKey),
    index('loyalty_program_progress_events_progress_idx').on(table.progressId, table.createdAt),
  ],
);

export const LOYALTY_ENTITLEMENT_STATUSES = ['available', 'redeemed', 'expired', 'reversed'] as const;

/** A reward a programme has earned for a customer (a completed stamp cycle, a milestone, a streak, a mission). Single use. */
export const loyaltyProgramEntitlements = pgTable(
  'loyalty_program_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    programId: uuid('program_id').notNull(),
    programVersion: integer('program_version').notNull(),
    loyaltyAccountId: uuid('loyalty_account_id').notNull().references(() => loyaltyAccounts.id, { onDelete: 'restrict' }),
    rewardId: uuid('reward_id').notNull().references(() => loyaltyRewards.id, { onDelete: 'restrict' }),
    sourceKey: text('source_key').notNull(),
    status: text('status').notNull().default('available'),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    redeemedBy: uuid('redeemed_by'),
  },
  (table) => [
    foreignKey({ columns: [table.programId, table.businessId], foreignColumns: [loyaltyPrograms.id, loyaltyPrograms.businessId], name: 'loyalty_program_entitlements_program_business_fk' }).onDelete('restrict'),
    uniqueIndex('loyalty_program_entitlements_source_uq').on(table.programId, table.loyaltyAccountId, table.sourceKey),
    index('loyalty_program_entitlements_account_status_idx').on(table.loyaltyAccountId, table.status),
    check('loyalty_program_entitlements_status_check', sql.raw(`"loyalty_program_entitlements"."status" IN (${LOYALTY_ENTITLEMENT_STATUSES.map((s) => `'${s}'`).join(',')})`)),
  ],
);
