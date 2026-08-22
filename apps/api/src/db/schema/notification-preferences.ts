import { pgTable, uuid, text, boolean, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';
import { customers } from './customers';
import { auditColumns } from './_shared';

/**
 * Per-recipient, per-business, per-event-type, per-channel opt-in/out
 * (Notifications Block 1). Exactly one of userId/customerId is set (CHECK
 * below) -- mirrors the platform's established dual-identity split (staff
 * vs. customer, see ARCHITECTURE.md's Multi-Tenancy Model) rather than a
 * polymorphic recipient reference, a pattern this schema uses nowhere else.
 *
 * businessId is NOT NULL even for customer rows: a preference is scoped per
 * business (mirrors loyalty_accounts being business-scoped even though
 * `customers` itself is global) -- a customer can opt out of SMS from
 * Business A while staying opted in at Business B.
 *
 * `enabled` defaults true (opt-out model). Deliberate for this platform's
 * v1 event set, which is entirely TRANSACTIONAL (new feedback, points
 * earned, etc.), not promotional -- defaulting transactional notifications
 * on matches common practice, and a customer has already consented to
 * contact by completing SMS OTP verification. If a future PROMOTIONAL
 * event type is ever added to shared-types' notificationEventTypeSchema,
 * it must default to false (opt-in) instead -- do not blindly extend this
 * default to a new event type without checking which category it falls in.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    channel: text('channel').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    ...auditColumns,
  },
  (table) => [
    // Two PARTIAL unique indexes, not one combined index -- Postgres treats
    // NULL <> NULL in a uniqueness check, so a single index on
    // (businessId, userId, customerId, eventType, channel) would silently
    // fail to prevent duplicate customer-side rows (userId always NULL
    // there) or duplicate staff-side rows (customerId always NULL there).
    // Same partial-index technique as qr_codes' one-active-code-per-branch
    // constraint, applied here for the opposite reason (nullable-column
    // uniqueness, not a status filter).
    uniqueIndex('notification_preferences_user_event_channel_key')
      .on(table.businessId, table.userId, table.eventType, table.channel)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex('notification_preferences_customer_event_channel_key')
      .on(table.businessId, table.customerId, table.eventType, table.channel)
      .where(sql`${table.customerId} IS NOT NULL`),
    index('notification_preferences_user_idx').on(table.userId),
    index('notification_preferences_customer_idx').on(table.customerId),
    check(
      'notification_preferences_exactly_one_recipient_check',
      sql`(${table.userId} IS NULL) <> (${table.customerId} IS NULL)`,
    ),
    check(
      'notification_preferences_event_type_check',
      sql`${table.eventType} IN ('feedback_received', 'summary_ready', 'redemption_pending', 'points_earned', 'tier_upgraded', 'reward_redeemed', 'message_reply_received', 'message_received', 'critical_feedback_alert')`,
    ),
    check('notification_preferences_channel_check', sql`${table.channel} IN ('email', 'sms', 'push')`),
  ],
);
