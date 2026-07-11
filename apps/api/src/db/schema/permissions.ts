import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Global, platform-defined capability catalog -- NOT tenant-scoped. Rows
 * correspond to capabilities the codebase actually implements, so this table
 * is seeded by migrations as features ship (starting with team-management
 * permissions in Block 6), never created ad hoc by a business or the API.
 */
export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(), // e.g. "team:invite", "roles:manage"
  description: text('description').notNull(),
  category: text('category').notNull(), // groups permissions for UI display
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
