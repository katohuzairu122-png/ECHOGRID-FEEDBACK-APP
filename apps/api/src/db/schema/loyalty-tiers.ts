import { pgTable, uuid, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { businesses } from './businesses';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * Business-configurable loyalty tiers (e.g. Bronze/Silver/Gold). `benefits`
 * is deliberately plain descriptive text, not a structured rules engine --
 * this module has no automated benefit-application mechanism (discounts
 * apply through staff judgment / the reward catalog, not an automatic
 * tier-benefit engine), so a rules schema here would model a feature that
 * doesn't exist yet.
 */
export const loyaltyTiers = pgTable(
  'loyalty_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    minPoints: integer('min_points').notNull(),
    benefits: text('benefits'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [uniqueIndex('loyalty_tiers_business_name_key').on(table.businessId, table.name)],
);
