import { boolean, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Creation/modification tracking. Spread into every tenant-owned, user-mutable
 * table so audit columns are identical everywhere instead of hand-repeated.
 *
 * createdBy/updatedBy are plain nullable UUIDs with NO foreign key to `users`,
 * on purpose: a real FK on every table would force users.ts to self-reference
 * (a user's own createdBy points at another user) and would couple every
 * table's migration order to `users` existing first. These columns are
 * metadata, not relational integrity -- the repository layer (Block 4) joins
 * to `users` when a UI needs to display "created by," and referential
 * correctness is enforced at the application layer instead.
 */
export const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
};

/**
 * Soft-delete tracking, kept separate from auditColumns: some tables
 * (permissions, audit_log, join tables) intentionally opt out of soft delete.
 */
export const softDeleteColumns = {
  isDeleted: boolean('is_deleted').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
};
