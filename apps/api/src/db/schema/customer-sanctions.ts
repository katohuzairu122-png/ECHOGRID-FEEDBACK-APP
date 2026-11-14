import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { users } from './users';

/**
 * Append-only history of platform moderation actions against a customer
 * (warning, suspension, ban, lift). Never updated or deleted: the current
 * state lives on `customers.status`, this table is the evidence of how it got
 * there and is what lets a suspension be required to follow a warning.
 */
export const customerSanctions = pgTable(
  'customer_sanctions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    action: text('action').notNull(), // warning | limit | suspend | ban | lift
    reason: text('reason').notNull(),
    // End of a limit or suspension; NULL for warning, ban and lift.
    suspendedUntil: timestamp('suspended_until', { withTimezone: true }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('customer_sanctions_customer_idx').on(table.customerId, table.createdAt),
    check(
      'customer_sanctions_action_check',
      sql`${table.action} IN ('warning', 'limit', 'suspend', 'ban', 'lift')`,
    ),
    check('customer_sanctions_reason_check', sql`length(btrim(${table.reason})) > 0`),
  ],
);
