import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { conversations } from './conversations';

/**
 * Append-only ledger, mirroring loyalty_transactions.ts/notifications.ts --
 * no soft-delete columns, no auditColumns (just createdAt), since a message
 * is never edited or removed after being sent. `senderId` is a plain UUID
 * with NO foreign key -- same reasoning as auditColumns' createdBy: it
 * points at either `users` (senderType='staff') or `customers`
 * (senderType='customer'), and a single FK can't target two tables.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').notNull(),
    senderId: uuid('sender_id').notNull(),
    body: text('body').notNull(),
    // Set when the OTHER party views the conversation, not by the sender.
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    // Backs unread-count queries: WHERE conversation_id = X AND sender_type = Y AND read_at IS NULL.
    index('messages_conversation_sender_unread_idx').on(table.conversationId, table.senderType, table.readAt),
    check('messages_sender_type_check', sql`${table.senderType} IN ('staff', 'customer')`),
    check('messages_body_check', sql`length(${table.body}) > 0 AND length(${table.body}) <= 5000`),
  ],
);
