import { pgTable, uuid, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { businesses } from './businesses';
import { branches } from './branches';
import { roles } from './roles';

/**
 * Grants a role to a user at a business, either business-wide (branchId
 * NULL) or scoped to one branch. This -- not a column on `users` -- is the
 * source of truth for "which businesses does this user belong to" and "what
 * can they do," since one person can hold different roles at different
 * businesses or branches. Revocation is a soft delete (deletedAt/deletedBy)
 * so access history survives for security/compliance review.
 */
export const userBusinessRoles = pgTable(
  'user_business_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    index('ubr_user_id_idx').on(table.userId),
    index('ubr_business_id_idx').on(table.businessId),
    // Two partial unique indexes instead of one composite: branchId is
    // nullable and Postgres treats every NULL as distinct, so a plain
    // UNIQUE(..., branch_id, ...) would silently allow duplicate
    // business-wide grants for the same user/business/role.
    uniqueIndex('ubr_branch_scoped_unique')
      .on(table.userId, table.businessId, table.branchId, table.roleId)
      .where(sql`${table.branchId} IS NOT NULL`),
    uniqueIndex('ubr_business_wide_unique')
      .on(table.userId, table.businessId, table.roleId)
      .where(sql`${table.branchId} IS NULL`),
  ],
);
