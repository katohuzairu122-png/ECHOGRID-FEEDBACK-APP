import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { businesses } from './businesses';
import { branches } from './branches';
import { users } from './users';
import { businessCustomerMemberships } from './business-customer-memberships';
import { loyaltyAccounts } from './loyalty-accounts';
import { loyaltyTransactions } from './loyalty-transactions';
import { loyaltyRewards } from './loyalty-rewards';
import { customerActionAuthorizations } from './customer-action-authorizations';

export const ORPHAN_CLAIM_STATUSES = [
  'available',
  'reserved',
  'settled',
  'expired',
  'reversed',
  'cancelled',
] as const;
export type OrphanClaimStatus = (typeof ORPHAN_CLAIM_STATUSES)[number];

export const ORPHAN_REASONS = [
  'origin_business_archived',
  'platform_unable_to_honor',
] as const;
export type OrphanReason = (typeof ORPHAN_REASONS)[number];

export const ORPHAN_SOURCE_REWARD_TYPES = [
  'discount',
  'free_item',
  'voucher',
] as const;
export type OrphanSourceRewardType = (typeof ORPHAN_SOURCE_REWARD_TYPES)[number];

export const ORPHAN_SETTLEMENT_STATUSES = [
  'proposed',
  'accepted',
  'reserved',
  'completion_authorized',
  'fulfilled',
  'cancelled',
  'expired',
  'reversed',
] as const;
export type OrphanSettlementStatus = (typeof ORPHAN_SETTLEMENT_STATUSES)[number];

export const ORPHAN_SETTLEMENT_EVENT_TYPES = [
  'orphan_created',
  'partner_selected',
  'partner_accepted',
  'settlement_reserved',
  'completion_authorized',
  'settlement_fulfilled',
  'settlement_expired',
  'settlement_cancelled',
  'settlement_reversed',
] as const;
export type OrphanSettlementEventType =
  (typeof ORPHAN_SETTLEMENT_EVENT_TYPES)[number];

export const orphanRewardClaims = pgTable(
  'orphan_reward_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    originBusinessId: uuid('origin_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    originMembershipId: uuid('origin_membership_id').references(
      () => businessCustomerMemberships.id,
      { onDelete: 'restrict' },
    ),
    originLoyaltyAccountId: uuid('origin_loyalty_account_id')
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: 'restrict' }),
    originLoyaltyTransactionId: uuid('origin_loyalty_transaction_id')
      .notNull()
      .references(() => loyaltyTransactions.id, { onDelete: 'restrict' }),
    originRewardId: uuid('origin_reward_id').references(() => loyaltyRewards.id, {
      onDelete: 'set null',
    }),
    orphanReason: text('orphan_reason').$type<OrphanReason>().notNull(),
    status: text('status').$type<OrphanClaimStatus>().notNull().default('available'),
    sourceRewardType: text('source_reward_type')
      .$type<OrphanSourceRewardType>()
      .notNull(),
    sourceRewardSnapshot: jsonb('source_reward_snapshot')
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('orphan_reward_claims_source_transaction_key').on(
      table.originLoyaltyTransactionId,
    ),
    index('orphan_reward_claims_customer_status_idx').on(table.customerId, table.status),
    index('orphan_reward_claims_origin_business_status_idx').on(
      table.originBusinessId,
      table.status,
    ),
    check(
      'orphan_reward_claims_reason_check',
      sql`${table.orphanReason} IN ('origin_business_archived','platform_unable_to_honor')`,
    ),
    check(
      'orphan_reward_claims_status_check',
      sql`${table.status} IN ('available','reserved','settled','expired','reversed','cancelled')`,
    ),
    check(
      'orphan_reward_claims_source_reward_type_check',
      sql`${table.sourceRewardType} IN ('discount','free_item','voucher')`,
    ),
    check(
      'orphan_reward_claims_settled_at_check',
      sql`${table.status} <> 'settled' OR ${table.settledAt} IS NOT NULL`,
    ),
    check(
      'orphan_reward_claims_expired_at_check',
      sql`${table.status} <> 'expired' OR ${table.expiredAt} IS NOT NULL`,
    ),
    check(
      'orphan_reward_claims_reversed_at_check',
      sql`${table.status} <> 'reversed' OR ${table.reversedAt} IS NOT NULL`,
    ),
  ],
);

export const orphanSettlements = pgTable(
  'orphan_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => orphanRewardClaims.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    receivingBusinessId: uuid('receiving_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    receivingBranchId: uuid('receiving_branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<OrphanSettlementStatus>().notNull().default('proposed'),
    accessAuthorizationId: uuid('access_authorization_id')
      .notNull()
      .references(() => customerActionAuthorizations.id, { onDelete: 'restrict' }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    completionAuthorizationId: uuid('completion_authorization_id').references(
      () => customerActionAuthorizations.id,
      { onDelete: 'restrict' },
    ),
    completionAuthorizedAt: timestamp('completion_authorized_at', {
      withTimezone: true,
    }),
    fulfilledByUserId: uuid('fulfilled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfillmentPolicyVersion: text('fulfillment_policy_version'),
    fulfillmentSnapshot: jsonb('fulfillment_snapshot').$type<Record<string, unknown>>(),
    fulfillmentReference: text('fulfillment_reference'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('orphan_settlements_idempotency_key').on(table.idempotencyKey),
    uniqueIndex('orphan_settlements_active_claim_key')
      .on(table.claimId)
      .where(
        sql`${table.status} IN ('accepted','reserved','completion_authorized')`,
      ),
    index('orphan_settlements_customer_status_idx').on(table.customerId, table.status),
    index('orphan_settlements_receiving_business_status_idx').on(
      table.receivingBusinessId,
      table.status,
    ),
    check(
      'orphan_settlements_status_check',
      sql`${table.status} IN ('proposed','accepted','reserved','completion_authorized','fulfilled','cancelled','expired','reversed')`,
    ),
    check(
      'orphan_settlements_acceptance_check',
      sql`${table.status} NOT IN ('accepted','reserved','completion_authorized','fulfilled')
        OR (${table.acceptedByUserId} IS NOT NULL AND ${table.acceptedAt} IS NOT NULL)`,
    ),
    check(
      'orphan_settlements_completion_authorization_check',
      sql`${table.status} NOT IN ('completion_authorized','fulfilled')
        OR (${table.completionAuthorizationId} IS NOT NULL AND ${table.completionAuthorizedAt} IS NOT NULL)`,
    ),
    check(
      'orphan_settlements_fulfillment_check',
      sql`${table.status} <> 'fulfilled'
        OR (${table.fulfilledByUserId} IS NOT NULL
          AND ${table.fulfilledAt} IS NOT NULL
          AND ${table.fulfillmentPolicyVersion} IS NOT NULL
          AND ${table.fulfillmentSnapshot} IS NOT NULL)`,
    ),
    check(
      'orphan_settlements_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const orphanSettlementEvents = pgTable(
  'orphan_settlement_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => orphanRewardClaims.id, { onDelete: 'restrict' }),
    settlementId: uuid('settlement_id').references(() => orphanSettlements.id, {
      onDelete: 'restrict',
    }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    eventType: text('event_type').$type<OrphanSettlementEventType>().notNull(),
    originBusinessId: uuid('origin_business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    receivingBusinessId: uuid('receiving_business_id').references(
      () => businesses.id,
      { onDelete: 'restrict' },
    ),
    receivingBranchId: uuid('receiving_branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    customerActionAuthorizationId: uuid('customer_action_authorization_id').references(
      () => customerActionAuthorizations.id,
      { onDelete: 'restrict' },
    ),
    idempotencyKey: text('idempotency_key').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('orphan_settlement_events_idempotency_key').on(table.idempotencyKey),
    index('orphan_settlement_events_claim_created_idx').on(table.claimId, table.createdAt),
    index('orphan_settlement_events_settlement_created_idx').on(
      table.settlementId,
      table.createdAt,
    ),
    index('orphan_settlement_events_receiving_business_created_idx').on(
      table.receivingBusinessId,
      table.createdAt,
    ),
    check(
      'orphan_settlement_events_type_check',
      sql`${table.eventType} IN ('orphan_created','partner_selected','partner_accepted','settlement_reserved','completion_authorized','settlement_fulfilled','settlement_expired','settlement_cancelled','settlement_reversed')`,
    ),
    check(
      'orphan_settlement_events_branch_business_check',
      sql`${table.receivingBranchId} IS NULL OR ${table.receivingBusinessId} IS NOT NULL`,
    ),
    check(
      'orphan_settlement_events_settlement_required_check',
      sql`${table.eventType} = 'orphan_created' OR ${table.settlementId} IS NOT NULL`,
    ),
  ],
);
