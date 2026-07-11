import { pgTable, uuid, boolean, integer, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { auditColumns } from './_shared';

/**
 * Per-business notification kill switches + SMS cost cap (Notifications
 * Block 1). Same "lazily created with defaults on first read" pattern as
 * loyalty_settings -- one row per business, repository's
 * getOrCreateDefaults() inserts a default row on first access so businesses
 * that never touch settings still get a consistent row.
 *
 * Exists specifically because feedback submission is a public, rate-limited
 * (20/min/IP) but UNAUTHENTICATED endpoint, and this module wires a
 * 'feedback_received' notification to it (Block 3) -- someone spamming that
 * endpoint within the existing rate limit could otherwise run up a
 * business's SMS bill with no ceiling. `maxSmsPerDay` is a real,
 * per-business-configurable cap (not a hardcoded platform constant, see
 * "never hard-code limits") that NotificationService checks before sending
 * an SMS (not email -- email has no meaningful per-send cost at this
 * platform's scale, so only SMS gets a cap). `smsEnabled`/`emailEnabled`
 * are separate, coarser kill switches for a business that wants notifications
 * off entirely for a channel, independent of the cap.
 */
export const businessNotificationSettings = pgTable(
  'business_notification_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    smsEnabled: boolean('sms_enabled').notNull().default(true),
    // Starting default, not derived from real usage data -- same
    // "flagged estimate" treatment as PUBLIC_RATE_LIMITER's 20/min figure.
    // Revisit once real per-business SMS volume is known.
    maxSmsPerDay: integer('max_sms_per_day').notNull().default(50),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('business_notification_settings_business_id_key').on(table.businessId),
    check('business_notification_settings_max_sms_check', sql`${table.maxSmsPerDay} >= 0`),
  ],
);
