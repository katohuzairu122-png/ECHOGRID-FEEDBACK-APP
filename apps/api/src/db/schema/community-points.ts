import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { businesses } from './businesses';
import { branches } from './branches';

export const COMMUNITY_MEMBERSHIP_STATUSES = ['active', 'left', 'suspended'] as const;
export type CommunityMembershipStatus = (typeof COMMUNITY_MEMBERSHIP_STATUSES)[number];

export const COMMUNITY_POINT_ACCOUNT_STATUSES = ['active', 'suspended', 'closed'] as const;
export type CommunityPointAccountStatus = (typeof COMMUNITY_POINT_ACCOUNT_STATUSES)[number];

export const COMMUNITY_POINT_RULE_STATUSES = ['draft', 'active', 'paused', 'retired'] as const;
export type CommunityPointRuleStatus = (typeof COMMUNITY_POINT_RULE_STATUSES)[number];

export const COMMUNITY_POINT_EARNING_SOURCES = ['survey_completion'] as const;
export type CommunityPointEarningSource = (typeof COMMUNITY_POINT_EARNING_SOURCES)[number];

export const COMMUNITY_POINT_RULE_RESOURCE_TYPES = ['survey_campaign'] as const;
export type CommunityPointRuleResourceType = (typeof COMMUNITY_POINT_RULE_RESOURCE_TYPES)[number];

export const COMMUNITY_POINT_AWARD_DECISION_STATUSES = [
  'pending_membership',
  'awarded',
  'rejected',
  'reversed',
] as const;
export type CommunityPointAwardDecisionStatus =
  (typeof COMMUNITY_POINT_AWARD_DECISION_STATUSES)[number];

export const COMMUNITY_POINT_TRANSACTION_TYPES = [
  'earn',
  'redeem',
  'reverse',
  'expire',
  'admin_adjustment',
] as const;
export type CommunityPointTransactionType =
  (typeof COMMUNITY_POINT_TRANSACTION_TYPES)[number];

export const COMMUNITY_POINT_TRANSACTION_SOURCES = [
  'survey_completion',
  'redemption',
  'reversal',
  'expiration',
  'admin_adjustment',
] as const;
export type CommunityPointTransactionSource =
  (typeof COMMUNITY_POINT_TRANSACTION_SOURCES)[number];

export const communityMemberships = pgTable(
  'community_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    status: text('status').$type<CommunityMembershipStatus>().notNull().default('active'),
    policyVersion: text('policy_version').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('community_memberships_customer_key').on(table.customerId),
    index('community_memberships_status_idx').on(table.status),
    check(
      'community_memberships_status_check',
      sql`${table.status} IN ('active','left','suspended')`,
    ),
    check(
      'community_memberships_left_at_check',
      sql`${table.status} <> 'left' OR ${table.leftAt} IS NOT NULL`,
    ),
    check(
      'community_memberships_suspended_at_check',
      sql`${table.status} <> 'suspended' OR ${table.suspendedAt} IS NOT NULL`,
    ),
  ],
);

export const communityPointAccounts = pgTable(
  'community_point_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    status: text('status').$type<CommunityPointAccountStatus>().notNull().default('active'),
    pointsBalance: integer('points_balance').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('community_point_accounts_customer_key').on(table.customerId),
    index('community_point_accounts_status_idx').on(table.status),
    check(
      'community_point_accounts_status_check',
      sql`${table.status} IN ('active','suspended','closed')`,
    ),
  ],
);

export const communityPointRules = pgTable(
  'community_point_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: text('source_type').$type<CommunityPointEarningSource>().notNull(),
    resourceType: text('resource_type').$type<CommunityPointRuleResourceType>(),
    resourceId: uuid('resource_id'),
    version: integer('version').notNull(),
    status: text('status').$type<CommunityPointRuleStatus>().notNull().default('draft'),
    points: integer('points').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('community_point_rules_global_version_key')
      .on(table.sourceType, table.version)
      .where(sql`${table.resourceType} IS NULL AND ${table.resourceId} IS NULL`),
    uniqueIndex('community_point_rules_resource_version_key')
      .on(table.sourceType, table.resourceType, table.resourceId, table.version)
      .where(sql`${table.resourceType} IS NOT NULL AND ${table.resourceId} IS NOT NULL`),
    index('community_point_rules_source_status_idx').on(table.sourceType, table.status),
    index('community_point_rules_resource_idx').on(table.resourceType, table.resourceId),
    check(
      'community_point_rules_source_type_check',
      sql`${table.sourceType} IN ('survey_completion')`,
    ),
    check(
      'community_point_rules_resource_type_check',
      sql`${table.resourceType} IS NULL OR ${table.resourceType} IN ('survey_campaign')`,
    ),
    check(
      'community_point_rules_resource_pair_check',
      sql`(${table.resourceType} IS NULL) = (${table.resourceId} IS NULL)`,
    ),
    check(
      'community_point_rules_status_check',
      sql`${table.status} IN ('draft','active','paused','retired')`,
    ),
    check('community_point_rules_version_check', sql`${table.version} > 0`),
    check('community_point_rules_points_check', sql`${table.points} > 0`),
    check(
      'community_point_rules_window_check',
      sql`${table.startsAt} IS NULL OR ${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      'community_point_rules_activation_check',
      sql`${table.status} <> 'active' OR ${table.activatedAt} IS NOT NULL`,
    ),
    check(
      'community_point_rules_retirement_check',
      sql`${table.status} <> 'retired' OR ${table.retiredAt} IS NOT NULL`,
    ),
  ],
);

export const communityPointAwardDecisions = pgTable(
  'community_point_award_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').references(() => communityPointAccounts.id, {
      onDelete: 'restrict',
    }),
    sourceType: text('source_type').$type<CommunityPointEarningSource>().notNull(),
    sourceRef: text('source_ref').notNull(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => communityPointRules.id, { onDelete: 'restrict' }),
    status: text('status').$type<CommunityPointAwardDecisionStatus>().notNull(),
    points: integer('points').notNull(),
    reasonCode: text('reason_code'),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    awardedTransactionId: uuid('awarded_transaction_id').references(
      (): AnyPgColumn => communityPointTransactions.id,
      { onDelete: 'restrict' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('community_point_award_decisions_source_rule_key').on(
      table.sourceType,
      table.sourceRef,
      table.ruleId,
    ),
    index('community_point_award_decisions_customer_status_idx').on(
      table.customerId,
      table.status,
    ),
    index('community_point_award_decisions_account_status_idx').on(
      table.accountId,
      table.status,
    ),
    check(
      'community_point_award_decisions_source_type_check',
      sql`${table.sourceType} IN ('survey_completion')`,
    ),
    check(
      'community_point_award_decisions_status_check',
      sql`${table.status} IN ('pending_membership','awarded','rejected','reversed')`,
    ),
    check('community_point_award_decisions_points_check', sql`${table.points} > 0`),
    check(
      'community_point_award_decisions_awarded_account_check',
      sql`${table.status} NOT IN ('awarded','reversed') OR ${table.accountId} IS NOT NULL`,
    ),
  ],
);

export const communityPointTransactions = pgTable(
  'community_point_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => communityPointAccounts.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    type: text('type').$type<CommunityPointTransactionType>().notNull(),
    points: integer('points').notNull(),
    sourceType: text('source_type').$type<CommunityPointTransactionSource>().notNull(),
    sourceRef: text('source_ref'),
    ruleId: uuid('rule_id').references(() => communityPointRules.id, {
      onDelete: 'restrict',
    }),
    awardDecisionId: uuid('award_decision_id').references(
      () => communityPointAwardDecisions.id,
      { onDelete: 'restrict' },
    ),
    businessId: uuid('business_id').references(() => businesses.id, {
      onDelete: 'set null',
    }),
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }),
    reversalOf: uuid('reversal_of').references(
      (): AnyPgColumn => communityPointTransactions.id,
      { onDelete: 'restrict' },
    ),
    idempotencyKey: text('idempotency_key').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (table) => [
    uniqueIndex('community_point_transactions_idempotency_key').on(table.idempotencyKey),
    uniqueIndex('community_point_transactions_reversal_key')
      .on(table.reversalOf)
      .where(sql`${table.reversalOf} IS NOT NULL`),
    index('community_point_transactions_account_created_idx').on(
      table.accountId,
      table.createdAt,
    ),
    index('community_point_transactions_customer_created_idx').on(
      table.customerId,
      table.createdAt,
    ),
    index('community_point_transactions_source_idx').on(
      table.sourceType,
      table.sourceRef,
    ),
    check(
      'community_point_transactions_type_check',
      sql`${table.type} IN ('earn','redeem','reverse','expire','admin_adjustment')`,
    ),
    check(
      'community_point_transactions_source_type_check',
      sql`${table.sourceType} IN ('survey_completion','redemption','reversal','expiration','admin_adjustment')`,
    ),
    check(
      'community_point_transactions_sign_check',
      sql`(${table.type} = 'earn' AND ${table.points} > 0)
        OR (${table.type} IN ('redeem','reverse','expire') AND ${table.points} < 0)
        OR (${table.type} = 'admin_adjustment' AND ${table.points} <> 0)`,
    ),
    check(
      'community_point_transactions_reversal_check',
      sql`(${table.type} = 'reverse' AND ${table.reversalOf} IS NOT NULL)
        OR (${table.type} <> 'reverse' AND ${table.reversalOf} IS NULL)`,
    ),
    check(
      'community_point_transactions_branch_business_check',
      sql`${table.branchId} IS NULL OR ${table.businessId} IS NOT NULL`,
    ),
  ],
);
