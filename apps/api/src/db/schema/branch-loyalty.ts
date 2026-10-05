import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  check,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { customers } from './customers';
import { auditColumns } from './_shared';

// RESTRICT preserves customer entitlements when a business leaves. Archive,
// never hard-delete a business/branch with these records.
export const branchLoyaltyPrograms = pgTable(
  'branch_loyalty_programs',
  {
    branchId: uuid('branch_id')
      .primaryKey()
      .references(() => branches.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    onboardingMode: text('onboarding_mode').notNull(),
    listedInCommunity: boolean('listed_in_community').notNull().default(false),
    qualifyingPurchaseDescription: text('qualifying_purchase_description').notNull(),
    unitLabel: text('unit_label').notNull(),
    rewardName: text('reward_name').notNull(),
    rewardCost: integer('reward_cost').notNull(),
    feedbackBonusUnits: integer('feedback_bonus_units').notNull().default(0),
    enabled: boolean('enabled').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    check('branch_program_mode_check', sql`${t.onboardingMode} IN ('business_only', 'community')`),
    check('branch_program_cost_check', sql`${t.rewardCost} > 0`),
    check('branch_program_feedback_bonus_check', sql`${t.feedbackBonusUnits} >= 0`),
  ],
);

export const customerCommunityChoices = pgTable('customer_community_choices', {
  customerId: uuid('customer_id')
    .primaryKey()
    .references(() => customers.id, { onDelete: 'cascade' }),
  joined: boolean('joined').notNull(),
  policyVersion: text('policy_version').notNull(),
  ...auditColumns,
});
export const branchLoyaltyMemberships = pgTable(
  'branch_loyalty_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branchLoyaltyPrograms.branchId, { onDelete: 'restrict' }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('branch_membership_customer_branch_key').on(t.customerId, t.branchId),
    index('branch_membership_business_idx').on(t.businessId),
  ],
);

// Ledger is the balance source of truth; only redemption confirmation is
// updated once. Refunds append compensating rows, never delete purchases.
export const branchLoyaltyLedger = pgTable(
  'branch_loyalty_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => branchLoyaltyMemberships.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    units: integer('units').notNull(),
    receiptReference: text('receipt_reference'),
    evidence: text('evidence'),
    reversalOf: uuid('reversal_of'),
    relatedPurchaseId: uuid('related_purchase_id'),
    requestId: uuid('request_id'),
    code: uuid('code'),
    rewardName: text('reward_name'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [
    check(
      'branch_ledger_type_check',
      sql`${t.type} IN ('purchase', 'feedback_bonus', 'redemption', 'refund')`,
    ),
    check(
      'branch_ledger_sign_check',
      sql`(${t.type} IN ('purchase', 'feedback_bonus') AND ${t.units} > 0) OR (${t.type} IN ('redemption', 'refund') AND ${t.units} < 0)`,
    ),
    check(
      'branch_ledger_reference_check',
      sql`(${t.type} = 'purchase' AND ${t.receiptReference} IS NOT NULL AND ${t.evidence} IS NOT NULL) OR (${t.type} = 'feedback_bonus' AND ${t.relatedPurchaseId} IS NOT NULL) OR (${t.type} = 'redemption' AND ${t.code} IS NOT NULL AND ${t.requestId} IS NOT NULL AND ${t.rewardName} IS NOT NULL) OR (${t.type} = 'refund' AND ${t.reversalOf} IS NOT NULL AND ${t.evidence} IS NOT NULL)`,
    ),
    foreignKey({ columns: [t.reversalOf], foreignColumns: [t.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.relatedPurchaseId], foreignColumns: [t.id] }).onDelete('restrict'),
    uniqueIndex('branch_ledger_feedback_purchase_key')
      .on(t.relatedPurchaseId)
      .where(sql`${t.type} = 'feedback_bonus'`),
    uniqueIndex('branch_ledger_receipt_key').on(t.businessId, t.branchId, t.receiptReference),
    uniqueIndex('branch_ledger_reversal_key').on(t.reversalOf),
    uniqueIndex('branch_ledger_request_key').on(t.membershipId, t.requestId),
    uniqueIndex('branch_ledger_code_key').on(t.code),
    index('branch_ledger_membership_idx').on(t.membershipId, t.createdAt),
  ],
);
