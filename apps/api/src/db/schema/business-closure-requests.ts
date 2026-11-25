import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';

export const BUSINESS_CLOSURE_STATUSES = ['pending', 'cancelled', 'processed'] as const;
export type BusinessClosureStatus = (typeof BUSINESS_CLOSURE_STATUSES)[number];

/**
 * BIZ-CLOSE-01: an owner's request to close a business. It is a REQUEST RECORD only: it deletes nothing, changes nothing about the
 * business's operation and does not wind anything down. Settlement, forfeiture, refund and retention rules are unapproved policy
 * (see docs/architecture/builds/TENTASHIP/BIZ_CLOSE_01_BUSINESS_CLOSURE_REQUEST.md), so processing is a controlled BLOCKED state and
 * `processed` is reserved: the database guard forbids it. The only application mutation after INSERT is pending -> cancelled
 * (owner withdrawal). One pending request per business (partial unique index). Holds no customer data.
 */
export const businessClosureRequests = pgTable(
  'business_closure_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').$type<BusinessClosureStatus>().notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /** Evidence: the obligation counts the owner was shown when filing (aggregate counts only). */
    obligationsSnapshot: jsonb('obligations_snapshot').$type<Record<string, number>>().notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('business_closure_requests_one_pending_idx').on(t.businessId).where(sql`${t.status} = 'pending'`),
    index('business_closure_requests_business_idx').on(t.businessId, t.requestedAt),
    index('business_closure_requests_pending_idx').on(t.requestedAt).where(sql`${t.status} = 'pending'`),
    check('business_closure_requests_status_check', sql`${t.status} IN ('pending', 'cancelled', 'processed')`),
    check(
      'business_closure_requests_cancel_shape_check',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL AND ${t.cancelledByUserId} IS NOT NULL)`,
    ),
  ],
);
