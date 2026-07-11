'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type {
  NotificationEventType,
  NotificationChannel,
  MaterializedNotificationPreferenceDto,
} from '@echo-grid-feedback/shared-types';
import { updateNotificationPreferencesAction } from '@/lib/actions/notifications';
import { gridKey, toPreferenceGrid, gridToPayload } from '@/lib/notification-preferences';
import { Button, Switch } from '@/components/ui';

interface PreferencesFormProps {
  eventTypes: readonly NotificationEventType[];
  channels: readonly NotificationChannel[];
  preferences: MaterializedNotificationPreferenceDto[];
}

/**
 * Staff-facing preferences grid (dashboard/notifications) -- self-service,
 * no permission gate (see notifications.routes.ts's file comment). Renders
 * as a controlled checkbox grid rather than a useActionState <form>, since
 * the PATCH payload is a nested array a raw FormData parse represents
 * poorly -- matches loyalty's imperative toggleRewardStatusAction pattern
 * (typed direct action call + useTransition) rather than SettingsForm's
 * FormData pattern, which fits flat fields (see this module's own
 * settings-form.tsx) but not this shape.
 *
 * The customer-facing counterpart
 * (loyalty/dashboard/[businessId]/notifications/notification-preferences-form.tsx)
 * duplicates this component's structure rather than sharing it -- different
 * auth system, different action module, different event-type set, the same
 * "two independent files despite structural overlap" choice
 * loyalty.ts/loyalty-customer.ts already made. Labels and grid-building
 * logic ARE shared, via lib/notification-preferences.ts.
 */
export function PreferencesForm({ eventTypes, channels, preferences }: PreferencesFormProps) {
  const [grid, setGrid] = useState(() => toPreferenceGrid(preferences));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // i18n & Multi-Currency Block 7 -- shared `notifications` namespace (not
  // staff-specific), see lib/notification-preferences.ts's file comment.
  const t = useTranslations('notifications');

  const handleToggle = (eventType: NotificationEventType, channel: NotificationChannel) => {
    setGrid((prev) => ({ ...prev, [gridKey(eventType, channel)]: !prev[gridKey(eventType, channel)] }));
    setSaved(false);
  };

  const handleSave = () => {
    setError(null);
    startTransition(async () => {
      try {
        await updateNotificationPreferencesAction(gridToPayload(grid, eventTypes, channels));
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
