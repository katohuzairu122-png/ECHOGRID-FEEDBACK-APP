import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { businesses } from './businesses';
import { branches } from './branches';
import { roles } from './roles';
import { users } from './users';

/** Pending access grants. Raw invitation tokens are never persisted. */
export const teamInvitations = pgTable(
  'team_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    invitedBy: uuid('invited_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('team_invitations_token_hash_key').on(table.tokenHash),
    index('team_invitations_business_id_idx').on(table.businessId),
    uniqueIndex('team_invitations_pending_branch_scope_key')
      .on(table.businessId, table.email, table.roleId, table.branchId)
      .where(sql`${table.branchId} IS NOT NULL AND ${table.acceptedAt} IS NULL AND ${table.cancelledAt} IS NULL`),
    uniqueIndex('team_invitations_pending_business_scope_key')
      .on(table.businessId, table.email, table.roleId)
      .where(sql`${table.branchId} IS NULL AND ${table.acceptedAt} IS NULL AND ${table.cancelledAt} IS NULL`),
  ],
);
