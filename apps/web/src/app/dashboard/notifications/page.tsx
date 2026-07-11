import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
  MaterializedNotificationPreferenceDto,
  BusinessNotificationSettingsDto,
  NotificationLogEntryDto,
} from '@echo-grid-feedback/shared-types';
import { STAFF_NOTIFICATION_EVENT_TYPES, DELIVERABLE_NOTIFICATION_CHANNELS } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { PreferencesForm } from './preferences-form';
import { SettingsForm } from './settings-form';
import { NotificationLog } from './notification-log';

/**
 * Notifications module's staff dashboard (Block 5). One page, three
 * sections -- unlike Loyalty (5 screens behind a subnav) or Analytics (a
 * dedicated /search sub-route), Notifications' three views are all small
 * and have no per-view URL state (no filters, no pagination params) worth a
 * dedicated route, so they stay stacked Cards on one page, matching this
 * app's "only split into a sub-route when a view needs its own
 * URL-addressable state" convention.
 *
 * Business settings and the send log are notifications:manage/:view-gated
 * at the API; this page fetches both regardless of the caller's role (see
 * settings-form.tsx's comment -- this app has no client-side
 * permission-hiding anywhere yet). A Staff member without notifications:view
 * hitting this page gets the resulting ApiError surfaced by Next's default
 * error handling -- the same pre-existing gap analytics/page.tsx already has
 * with analytics:view. Worth fixing platform-wide (a shared
 * "current user's effective permissions" helper + per-route guards) rather
 * than patched one module at a time; flagged in this block's Completion
 * Check as a suggested improvement, not fixed here to avoid touching
 * unrelated modules.
 */
export default async function NotificationsPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 7.
  const t = await getTranslations('notifications.staff');

  const [preferences, settings, log] = await Promise.all([
    apiFetch<MaterializedNotificationPreferenceDto[]>('/notifications/preferences', {
      businessId: business.id,
    }),
    apiFetch<BusinessNotificationSettingsDto>('/notifications/settings', { businessId: business.id }),
    apiFetch<NotificationLogEntryDto[]>('/notifications?limit=20', { businessId: business.id }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('myPreferencesTitle')}</CardTitle>
          <CardDescription>{t('myPreferencesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <PreferencesForm
            eventTypes={STAFF_NOTIFICATION_EVENT_TYPES}
            channels={DELIVERABLE_NOTIFICATION_CHANNELS}
            preferences={preferences}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('businessSettingsTitle')}</CardTitle>
          <CardDescription>{t('businessSettingsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm settings={settings} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">{t('log.heading')}</h2>
        <NotificationLog entries={log} />
      </div>
    </div>
  );
}
