import { pgTable, uuid, text, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { auditColumns, softDeleteColumns } from './_shared';
import { businesses } from './businesses';

/**
 * A named permission bundle, always owned by a business -- no shared/global
 * rows. New businesses get a starter set (Owner, Admin, Manager, Staff)
 * seeded by application logic in Block 6, not by this schema; businesses can
 * then rename, delete, or add to their own copies freely. Chosen over a
 * nullable-businessId "system role" design to avoid NULL-uniqueness edge
 * cases and keep every row's ownership unambiguous.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [uniqueIndex('roles_business_id_name_key').on(table.businessId, table.name)],
);
