import { pgTable, uuid, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { customers } from './customers';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * The thread container for staff <-> customer messaging -- one row per
 * (customer, business) pair, mirroring loyalty_accounts.ts exactly (same
 * identity-split reasoning: customers.ts is the global identity, this is
 * the business-scoped half). Staff can only message customers already
 * enrolled in the business's loyalty program (see loyalty_accounts), so
 * this always exists alongside a loyalty account for the same pair, not
 * independently.
 *
 * lastMessageAt/lastMessagePreview are DENORMALIZED, maintained alongside
 * each insert into `messages` (the source-of-truth ledger) -- same
 * running-total tradeoff as loyalty_accounts.points, so the conversation
 * list view never needs to join into messages just to sort/preview.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessagePreview: text('last_message_preview'),
    // Schema supports archiving from day one (same "exists for forward
    // compatibility" precedent as notificationChannelSchema enumerating
    // 'push' before it's implemented) -- no archive route/UI ships yet.
    status: text('status').notNull().default('open'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('conversations_customer_business_key').on(table.customerId, table.businessId),
    index('conversations_business_last_message_idx').on(table.businessId, table.lastMessageAt),
    check('conversations_status_check', sql`${table.status} IN ('open', 'closed')`),
  ],
);
