import { z } from 'zod';

/**
 * Notifications module contract. The event/channel vocabulary is defined
 * once here and consumed by both the DB schema's CHECK constraints
 * (apps/api/src/db/schema/notification-preferences.ts,
 * .../notifications.ts) and the API's validation -- a single source of
 * truth so the two can never drift apart, same reasoning as every other
 * shared enum in this package.
 *
 * Six events for v1, three staff-facing and three customer-facing (no
 * overlap -- a recipient only ever needs the half relevant to their own
 * identity system). Deliberately entirely TRANSACTIONAL, not promotional --
 * see notification-preferences.ts's schema comment for why that distinction
 * drives the `enabled` column's default.
 */
export const notificationEventTypeSchema = z.enum([
  'feedback_received',
  'summary_ready',
  'redemption_pending',
  'points_earned',
  'tier_upgraded',
  'reward_redeemed',
]);
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

/**
 * The staff/customer split of the 6 event types above -- consumed by both
 * the API (which set of events to materialize default preference rows for,
 * depending on whether the caller is staff or a customer) and the frontend
 * (which toggles to render on which settings screen). Kept here, not
 * re-derived ad hoc in either app, so the split can never drift from the
 * event list itself.
 */
export const STAFF_NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'feedback_received',
  'summary_ready',
  'redemption_pending',
];
export const CUSTOMER_NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'points_earned',
  'tier_upgraded',
  'reward_redeemed',
];

/**
 * 'push' is included even though no delivery implementation exists yet
 * (Notifications Block 2 ships email + sms only) -- this is a KNOWN future
 * channel, not an unbounded/undesigned one, so it's safe to enumerate now.
 * Mirrors `feedback.analysisStatus` including 'skipped' before anything
 * produced that value, rather than `qr_codes.type`'s "no CHECK at all
 * because future values aren't designed yet" treatment.
 */
export const notificationChannelSchema = z.enum(['email', 'sms', 'push']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/** Channels that actually deliver today -- 'push' is enumerated above for
 * forward-compatibility but NotificationDeliveryService (apps/api) has no
 * implementation for it yet, so a preferences UI should not render a toggle
 * for it (there is nothing for that toggle to control). */
export const DELIVERABLE_NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['email', 'sms'];

/** Shape returned by GET/PATCH .../preferences -- the materialized
 * (eventType x channel) grid (see NotificationService.listMaterializedPreferences),
 * NOT a full notificationPreferenceSchema row. A materialized entry may not
 * even have a backing DB row (no id/businessId/userId/customerId) if the
 * recipient never overrode the default -- that's the whole point of
 * materializing, see this module's Block 3/4 notes. */
export const materializedNotificationPreferenceSchema = z.object({
  eventType: notificationEventTypeSchema,
  channel: notificationChannelSchema,
  enabled: z.boolean(),
});
export type MaterializedNotificationPreferenceDto = z.infer<
  typeof materializedNotificationPreferenceSchema
>;

export const notificationPreferenceSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  userId: z.uuid().nullable(),
  customerId: z.uuid().nullable(),
  eventType: notificationEventTypeSchema,
  channel: notificationChannelSchema,
  enabled: z.boolean(),
});
export type NotificationPreferenceDto = z.infer<typeof notificationPreferenceSchema>;

/** One row per (eventType, channel) pair the caller wants to change --
 * PATCH accepts an array so a settings screen can save every toggle in one
 * request instead of one round trip per checkbox. */
export const updateNotificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        eventType: notificationEventTypeSchema,
        channel: notificationChannelSchema,
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(50),
});
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;

export const notificationLogEntrySchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  userId: z.uuid().nullable(),
  customerId: z.uuid().nullable(),
  eventType: notificationEventTypeSchema,
  channel: notificationChannelSchema,
  recipientAddress: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  status: z.enum(['pending', 'sent', 'failed']),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationLogEntryDto = z.infer<typeof notificationLogEntrySchema>;

export const businessNotificationSettingsSchema = z.object({
  businessId: z.uuid(),
  emailEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  maxSmsPerDay: z.number().int().min(0),
});
export type BusinessNotificationSettingsDto = z.infer<typeof businessNotificationSettingsSchema>;

/** PATCH body -- any subset. `maxSmsPerDay: 0` is a valid, meaningful value
 * (hard-stop SMS entirely without flipping smsEnabled off, e.g. to keep the
 * kill switch state visible/toggleable separately from the cap). */
export const updateBusinessNotificationSettingsSchema = z.object({
  emailEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  maxSmsPerDay: z.number().int().min(0).optional(),
});
export type UpdateBusinessNotificationSettingsInput = z.infer<
  typeof updateBusinessNotificationSettingsSchema
>;
