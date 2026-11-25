import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { branches } from './branches';
import { users } from './users';

/**
 * OWNER-INVITE-01: a customer invitation issued by the business owner side (never by a cashier credential) from the owner-facing Cashier App.
 * It is an ACQUISITION CHANNEL, not an enrolment: accepting it still needs the customer's own authentication and explicit join consent, and it
 * grants no Community membership, marketing consent, reward, badge, Shuffle or Drops eligibility. Business and branch come from this server
 * row (never from a client). Single use: the customer_onboarding_events `remote_invitation` unique index refuses a second use.
 *
 * Lifecycle facts: issued (row), expired (expires_at), revoked (revoked_at), accepted (an onboarding event references this id). The only
 * application update after INSERT is the one-time revocation (database guard); no DELETE, no TRUNCATE. Holds no customer data.
 */
export const customerInvitations = pgTable(
  'customer_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'restrict' }),
    issuedByUserId: uuid('issued_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    /** Optional caller-chosen key: repeating a create with the same key returns the same invitation (idempotency). */
    requestKey: text('request_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('customer_invitations_request_key_uq').on(t.businessId, t.issuedByUserId, t.requestKey).where(sql`${t.requestKey} IS NOT NULL`),
    index('customer_invitations_business_created_idx').on(t.businessId, t.createdAt),
    check('customer_invitations_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check('customer_invitations_revoke_shape_check', sql`(${t.revokedAt} IS NULL) = (${t.revokedByUserId} IS NULL)`),
    check('customer_invitations_request_key_length', sql`${t.requestKey} IS NULL OR char_length(${t.requestKey}) BETWEEN 8 AND 64`),
  ],
);
