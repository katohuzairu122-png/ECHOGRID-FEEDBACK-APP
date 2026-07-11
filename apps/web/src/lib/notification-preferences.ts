import type {
  NotificationEventType,
  NotificationChannel,
  MaterializedNotificationPreferenceDto,
} from '@echo-grid-feedback/shared-types';

/**
 * Pure grid helpers shared by both the staff
 * (dashboard/notifications/preferences-form.tsx) and customer
 * (loyalty/dashboard/[businessId]/notifications/notification-preferences-form.tsx)
 * preference screens. Each screen only ever renders its own
 * STAFF_/CUSTOMER_NOTIFICATION_EVENT_TYPES subset, but the
 * (eventType, channel) <-> flat-key conversion logic has no reason to be
 * duplicated per screen -- unlike the stateful form components themselves,
 * which stay two independent files (different auth systems, different
 * server actions), this is pure, side-effect-free logic, the same level of
 * sharing lib/branch-form.ts and lib/feedback-form.ts already establish for
 * other modules.
 *
 * Display labels used to live here as static NOTIFICATION_EVENT_LABELS /
 * NOTIFICATION_CHANNEL_LABELS Records, but useTranslations()/getTranslations()
 * can only be called inside a component, not a module-level object literal
 * (i18n & Multi-Currency Block 7) -- each consumer now calls
 * t(`events.${eventType}`) / t(`channels.${channel}`) against the shared
 * `notifications` namespace directly instead. The namespace being shared
 * (not split staff/customer) is what keeps the label text itself
 * de-duplicated across the two screens.
 */

/** Flat `${eventType}:${channel}` key -- lets a checkbox grid live in one
 * flat useState<Record<string, boolean>> instead of a nested structure. */
export function gridKey(eventType: NotificationEventType, channel: NotificationChannel): string {
  return `${eventType}:${channel}`;
}

export type PreferenceGrid = Record<string, boolean>;

/** Seeds a grid's initial state from the API's materialized list -- the API
 * already fills in every (eventType, channel) combination with its
 * effective value (explicit row or default), so this is a pure reshape, not
 * a second place that decides defaults. */
export function toPreferenceGrid(preferences: MaterializedNotificationPreferenceDto[]): PreferenceGrid {
  const grid: PreferenceGrid = {};
  for (const p of preferences) {
    grid[gridKey(p.eventType, p.channel)] = p.enabled;
  }
  return grid;
}

/** Inverse of toPreferenceGrid -- rebuilds the PATCH payload's array shape
 * from the grid's current (possibly-edited) state. `?? true` covers a key
 * that was somehow never seeded (defensive only; toPreferenceGrid always
 * seeds every eventTypes x channels combination the API returns) --
 * matches the same "no row = enabled" default the backend itself uses. */
export function gridToPayload(
  grid: PreferenceGrid,
  eventTypes: readonly NotificationEventType[],
  channels: readonly NotificationChannel[],
): Array<{ eventType: NotificationEventType; channel: NotificationChannel; enabled: boolean }> {
  return eventTypes.flatMap((eventType) =>
    channels.map((channel) => ({
      eventType,
      channel,
      enabled: grid[gridKey(eventType, channel)] ?? true,
    })),
  );
}
