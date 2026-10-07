import { pgTable, uuid, text, boolean, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const businessCategories = pgTable(
  'business_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    groupKey: text('group_key'),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('business_categories_key_key').on(table.key),
    index('business_categories_group_key_idx').on(table.groupKey),
    index('business_categories_active_sort_idx').on(table.isActive, table.sortOrder),
  ],
);
