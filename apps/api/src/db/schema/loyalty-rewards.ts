import { pgTable, uuid, text, integer, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * Business-configurable redeemable rewards. `status` (not soft-delete)
 * lets a business retire a reward from the active catalog while its
 * historical redemptions (loyalty_transactions.related_reward_id) stay
 * intact and readable.
 */
export const loyaltyRewards = pgTable(
  'loyalty_rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    pointsCost: integer('points_cost').notNull(),
    status: text('status').notNull().default('active'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    check('loyalty_rewards_status_check', sql`${table.status} IN ('active', 'inactive')`),
    check('loyalty_rewards_points_cost_check', sql`${table.pointsCost} > 0`),
  ],
);
