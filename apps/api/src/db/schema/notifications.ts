import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';
import { customers } from './customers';

/**
 * Append-only send log (Notifications Block 1) -- same ledger pattern as
 * `audit_log`/`loyalty_transactions`/`feedback_summaries`: one row per
 * attempted delivery, never edited afterward, only ever inserted. Powers
 * both a support-facing "what did we actually send this recipient" view and
 * the per-business daily SMS cap check (business-notification-settings.ts),
 * which counts rows here rather than maintaining a separate incrementing
 * counter column -- avoids an entire class of counter-drift bugs, and at
 * this cap's expected scale (tens to low hundreds of SMS/business/day) a
 * COUNT against an indexed (businessId, channel, createdAt) is cheap. This
 * is a different cost tradeoff than FeedbackRepository's pagination, which
 * deliberately avoids COUNT on a potentially large, frequently-paginated
 * table -- this one is small and bounded by the cap itself.
 *
 * `recipientAddress` snapshots the actual email/phone used at send time,
 * not a live join to users/customers -- a recipient's contact info can
 * change after the fact, and the log should reflect what really happened,
 * same "audit trail is a historical record, not a live view" principle
 * already applied to audit_log.metadata.
 *
 * Nullable userId/customerId (exactly one set, same CHECK pattern as
 * notification-preferences.ts) rather than a polymorphic reference, for the
 * same reasoning as that table.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    channel: text('channel').notNull(),
    recipientAddress: text('recipient_address').notNull(),
    subject: text('subject'), // null for SMS -- channel-appropriate, not every row needs one
    body: text('body').notNull(),
    status: text('status').notNull().default('pending'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notifications_business_created_idx').on(table.businessId, table.createdAt),
    index('notifications_user_idx').on(table.userId),
    index('notifications_customer_idx').on(table.customerId),
    // Backs the daily SMS cap check: COUNT(*) WHERE businessId=X AND
    // channel='sms' AND createdAt >= <today>.
    index('notifications_business_channel_created_idx').on(table.businessId, table.channel, table.createdAt),
    check(
      'notifications_exactly_one_recipient_check',
      sql`(${table.userId} IS NULL) <> (${table.customerId} IS NULL)`,
    ),
    check(
      'notifications_event_type_check',
      sql`${table.eventType} IN ('feedback_received', 'summary_ready', 'redemption_pending', 'points_earned', 'tier_upgraded', 'reward_redeemed')`,
    ),
    check('notifications_channel_check', sql`${table.channel} IN ('email', 'sms', 'push')`),
    check('notifications_status_check', sql`${table.status} IN ('pending', 'sent', 'failed')`),
  ],
);
