import { pgTable, uuid, text, integer, numeric, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * Business-configurable redeemable rewards. `status` (not soft-delete)
 * lets a business retire a reward from the active catalog while its
 * historical redemptions (loyalty_transactions.related_reward_id) stay
 * intact and readable.
 *
 * Continuing Development Block 6.1 (S6.1 Reward Panel fields) widens this
 * from a flat points-cost catalog into a typed campaign row -- schema only,
 * additive and backward-compatible. Every new column is nullable or
 * defaulted; `LoyaltyRewardService`'s `CreateRewardInput`/`UpdateRewardInput`
 * and `LoyaltyRewardRepository` are both untouched by this block and keep
 * working exactly as before (`LoyaltyReward`/`NewLoyaltyReward` are
 * `$inferSelect`/`$inferInsert`, so they pick up the new fields
 * automatically without a repository change). Four scoping decisions worth
 * recording:
 *
 * 1. `rewardValue` is generic and only meaningful for non-`'points'` types
 *    (discount amount/percentage, voucher face value). The `'points'` type
 *    keeps using `pointsCost`, completely unchanged -- this column is
 *    additive alongside it, not a replacement, so nothing about the
 *    existing points-catalog/redeem/confirm flow (`LoyaltyRedemptionService`)
 *    is touched.
 * 2. `branchId` scopes a reward to ONE specific branch, or every branch when
 *    NULL (business-wide, matching every existing row today). S6.1 says
 *    "redemption branches" (plural) -- a true multi-branch subset would need
 *    a join table. Deliberately deferred: single-branch-or-business-wide
 *    covers the common case, and a join table is a purely additive follow-up
 *    if a real multi-branch-subset need shows up later.
 * 3. `limitPer`/`limitPeriodDays` are CONFIG only -- they record which
 *    one-reward-per-X rule a campaign wants (S6.1: "one reward per receipt,
 *    visit or defined period"), not the enforcement itself. Actually
 *    enforcing them (plus `maxRewardsPerDay`/`maxBudget`) is Continuing
 *    Development Block 6.3, same reasoning Block 5.2 used for
 *    `visitSessionId`'s uniqueness index: the config and the enforcement
 *    are separable, and shipping config with no enforcement yet is safe
 *    because nothing reads these columns until 6.3 exists.
 * 4. `'paused'` is added to the status CHECK below, but
 *    `LoyaltyRewardService`'s `UpdateRewardInput.status` type is
 *    deliberately left as `'active' | 'inactive'` for now (untouched by
 *    this block) -- the DB can hold a `'paused'` row from a future direct
 *    write, but nothing can set one through the service yet. Widening that
 *    union is a Block 6.2+ decision, made once there's real paused-campaign
 *    behavior behind it, not just an unused extra status value.
 */
export const loyaltyRewards = pgTable(
  'loyalty_rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    // NULL = every branch (business-wide) -- matches every row that exists
    // today. See scoping decision 2 above for the single-branch-only limit.
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // 'points' (default) is today's only real type, unchanged in behavior.
    // 'discount' | 'free_item' | 'voucher' are S6.2's new campaign types --
    // this column only names them; their type-specific required controls
    // (discount cap/minimum purchase, free-item substitution, voucher
    // secure token/status history) are out of scope for this block.
    type: text('type').notNull().default('points'),
    pointsCost: integer('points_cost').notNull(),
    // Generic numeric value for non-points types -- see scoping decision 1.
    rewardValue: numeric('reward_value', { precision: 10, scale: 2 }),
    status: text('status').notNull().default('active'),
    startDate: timestamp('start_date', { withTimezone: true }),
    expiryDate: timestamp('expiry_date', { withTimezone: true }),
    maxRewardsPerDay: integer('max_rewards_per_day'),
    // Monetary cap on total campaign spend -- same precision/scale as
    // loyalty_transactions.purchase_amount, this codebase's existing
    // money-column precedent.
    maxBudget: numeric('max_budget', { precision: 10, scale: 2 }),
    // Which one-reward-per-X rule this campaign declares -- config only,
    // see scoping decision 3. NULL = no additional rule beyond the type's
    // own natural mechanics (e.g. points redemption is limited only by
    // account balance).
    limitPer: text('limit_per'),
    // Only meaningful when limitPer = 'period'.
    limitPeriodDays: integer('limit_period_days'),
    // Campaign-level customer cooldown, in seconds -- distinct from
    // limitPer/limitPeriodDays (S6.1 names both separately: "one reward per
    // receipt, visit or defined period" AND, separately, "customer
    // cooldown"). Config only, same as decision 3.
    cooldownSeconds: integer('cooldown_seconds'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    index('loyalty_rewards_business_branch_idx').on(table.businessId, table.branchId),
    check('loyalty_rewards_status_check', sql`${table.status} IN ('active', 'inactive', 'paused')`),
    check('loyalty_rewards_points_cost_check', sql`${table.pointsCost} > 0`),
    check(
      'loyalty_rewards_type_check',
      sql`${table.type} IN ('points', 'discount', 'free_item', 'voucher')`,
    ),
    check(
      'loyalty_rewards_reward_value_check',
      sql`${table.rewardValue} IS NULL OR ${table.rewardValue} > 0`,
    ),
    check(
      'loyalty_rewards_max_rewards_per_day_check',
      sql`${table.maxRewardsPerDay} IS NULL OR ${table.maxRewardsPerDay} > 0`,
    ),
    check('loyalty_rewards_max_budget_check', sql`${table.maxBudget} IS NULL OR ${table.maxBudget} > 0`),
    check(
      'loyalty_rewards_limit_per_check',
      sql`${table.limitPer} IS NULL OR ${table.limitPer} IN ('receipt', 'visit', 'period')`,
    ),
    check(
      'loyalty_rewards_limit_period_days_check',
      sql`${table.limitPeriodDays} IS NULL OR ${table.limitPeriodDays} > 0`,
    ),
    check(
      'loyalty_rewards_cooldown_seconds_check',
      sql`${table.cooldownSeconds} IS NULL OR ${table.cooldownSeconds} >= 0`,
    ),
    check(
      'loyalty_rewards_expiry_after_start_check',
      sql`${table.expiryDate} IS NULL OR ${table.startDate} IS NULL OR ${table.expiryDate} > ${table.startDate}`,
    ),
  ],
);
