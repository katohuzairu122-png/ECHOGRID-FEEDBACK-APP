import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

export const CUSTOMER_DELETION_RESTORE_DAYS = 30;
export const CUSTOMER_DELETION_STATUSES = ['pending', 'cancelled', 'processed'] as const;
export type CustomerDeletionStatus = (typeof CUSTOMER_DELETION_STATUSES)[number];

/**
 * CUST-DEL-01: a customer's "Delete my account data" request. App-owned and separate from the D2-FINAL privacy tables, which the
 * runtime can never reach. While a request is `pending` the account can use nothing except the restore screen; nothing is erased
 * and nothing is ever erased automatically. The only application mutation after INSERT is pending -> cancelled (database guard).
 * Holds no personal data: only the pseudonymous customer id and timestamps.
 */
export const customerDeletionRequests = pgTable(
  'customer_deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    status: text('status').$type<CustomerDeletionStatus>().notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('customer_deletion_requests_one_pending_idx').on(t.customerId).where(sql`${t.status} = 'pending'`),
    index('customer_deletion_requests_due_idx').on(t.scheduledFor).where(sql`${t.status} = 'pending'`),
    check('customer_deletion_requests_status_check', sql`${t.status} IN ('pending', 'cancelled', 'processed')`),
    check('customer_deletion_requests_window_check', sql`${t.scheduledFor} = ${t.requestedAt} + interval '30 days'`),
    check(
      'customer_deletion_requests_cancel_shape_check',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL)`,
    ),
  ],
);
