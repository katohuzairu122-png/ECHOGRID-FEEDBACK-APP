import { pgTable, uuid, text, integer, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { customers } from './customers';
import { loyaltyTiers } from './loyalty-tiers';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * The business-scoped half of the identity split (see customers.ts) --
 * one row per (customer, business) pair, mirroring how `user_business_roles`
 * is the business-scoped half of `users`. `points`/`visit_count`/
 * `last_visit_at` are DENORMALIZED running totals, maintained transactionally
 * alongside each insert into `loyalty_transactions` (the source of truth
 * ledger) rather than computed with a live SUM() on every read -- a
 * membership-card view needs to be fast, and the ledger stays the audit
 * trail if the running total is ever in question.
 *
 * `referred_by_customer_id` is business-scoped (not on `customers` itself)
 * because the REFERRAL REWARD is business-scoped even though identity is
 * global -- a referral bonus is earned at the business the referred
 * customer joined, not globally.
 */
export const loyaltyAccounts = pgTable(
  'loyalty_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    points: integer('points').notNull().default(0),
    tierId: uuid('tier_id').references(() => loyaltyTiers.id, { onDelete: 'set null' }),
    referredByCustomerId: uuid('referred_by_customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    visitCount: integer('visit_count').notNull().default(0),
    lastVisitAt: timestamp('last_visit_at', { withTimezone: true }),
    status: text('status').notNull().default('active'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('loyalty_accounts_customer_business_key').on(table.customerId, table.businessId),
    check('loyalty_accounts_status_check', sql`${table.status} IN ('active', 'suspended')`),
    check('loyalty_accounts_points_check', sql`${table.points} >= 0`),
  ],
);
