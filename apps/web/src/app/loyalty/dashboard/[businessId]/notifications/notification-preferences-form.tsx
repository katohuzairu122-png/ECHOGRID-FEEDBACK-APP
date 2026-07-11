'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type {
  NotificationEventType,
  NotificationChannel,
  MaterializedNotificationPreferenceDto,
} from '@echo-grid-feedback/shared-types';
import { updateNotificationPreferencesAction } from '@/lib/actions/loyalty-customer';
import { gridKey, toPreferenceGrid, gridToPayload } from '@/lib/notification-preferences';
import { Button, Switch } from '@/components/ui';

interface NotificationPreferencesFormProps {
  businessId: string;
  eventTypes: readonly NotificationEventType[];
  channels: readonly NotificationChannel[];
  preferences: MaterializedNotificationPreferenceDto[];
}

/**
 * Customer-facing counterpart to
 * dashboard/notifications/preferences-form.tsx -- same grid UX, but scoped
 * to one business (businessId is a route param here, not a staff session's
 * active business) and posts through the customer JWT via
 * lib/actions/loyalty-customer.ts. Kept as a separate component rather than
 * shared with the staff version -- different auth system, different action
 * module, different event-type set -- the same "two independent files"
 * choice loyalty.ts/loyalty-customer.ts already made; labels and
 * grid-building logic ARE shared, via lib/notification-preferences.ts.
 */
export function NotificationPreferencesForm({
  businessId,
  eventTypes,
  channels,
  preferences,
}: NotificationPreferencesFormProps) {
  const [grid, setGrid] = useState(() => toPreferenceGrid(preferences));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // i18n & Multi-Currency Block 7 -- shared `notifications` namespace (not
  // customer-specific), see lib/notification-preferences.ts's file comment.
  const t = useTranslations('notifications');

  const handleToggle = (eventType: NotificationEventType, channel: NotificationChannel) => {
    setGrid((prev) => ({ ...prev, [gridKey(eventType, channel)]: !prev[gridKey(eventType, channel)] }));
    setSaved(false);
  };

  const handleSave = () => {
    setError(null);
    startTransition(async () => {
      try {
        await updateNotificationPreferencesAction(businessId, gridToPayload(grid, eventTypes, channels));
        setSaved(true);
      } catch {
        setError(t('preferences.saveFailedAlert'));
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="pb-2 text-left font-medium text-neutral-500">{t('preferences.eventColumn')}</th>
            {channels.map((channel) => (
              <th key={channel} className="pb-2 text-center font-medium text-neutral-500">
                {t(`channels.${channel}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {eventTypes.map((eventType) => (
            <tr key={eventType}>
              <td className="py-3 text-neutral-800">{t(`events.${eventType}`)}</td>
              {channels.map((channel) => (
                <td key={channel} className="py-3 text-center">
                  <Switch
                    aria-label={t('preferences.channelAriaLabel', {
                      channel: t(`channels.${channel}`),
                      event: t(`events.${eventType}`),
                    })}
                    checked={grid[gridKey(eventType, channel)] ?? true}
                    onChange={() => handleToggle(eventType, channel)}
                    disabled={pending}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {saved && !pending && <p className="text-sm text-success">{t('preferences.saved')}</p>}
      <Button type="button" onClick={handleSave} disabled={pending} className="w-fit">
        {pending ? t('preferences.saving') : t('preferences.save')}
      </Button>
    </div>
  );
}
