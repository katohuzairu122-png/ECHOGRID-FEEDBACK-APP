'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { BusinessNotificationSettingsDto } from '@echo-grid-feedback/shared-types';
import {
  updateNotificationSettingsAction,
  type NotificationSettingsFormState,
} from '@/lib/actions/notifications';
import { Button, Input, Label, Switch } from '@/components/ui';

const initialState: NotificationSettingsFormState = {};

/** notifications:manage-gated at the API -- a Staff member submitting this
 * gets the resulting 403 surfaced via state.error, same as every other
 * permission-gated form in this app (see actions/notifications.ts's file
 * comment; this app has no client-side permission-hiding anywhere yet). */
export function SettingsForm({ settings }: { settings: BusinessNotificationSettingsDto }) {
  const [state, formAction, pending] = useActionState(updateNotificationSettingsAction, initialState);
  // i18n & Multi-Currency Block 7.
  const t = useTranslations('notifications.staff.settings');

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-neutral-800">{t('emailLabel')}</p>
          <p className="text-xs text-neutral-500">{t('emailDescription')}</p>
        </div>
        <Switch name="emailEnabled" defaultChecked={settings.emailEnabled} aria-label={t('emailAriaLabel')} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-neutral-800">{t('smsLabel')}</p>
          <p className="text-xs text-neutral-500">{t('smsDescription')}</p>
        </div>
        <Switch name="smsEnabled" defaultChecked={settings.smsEnabled} aria-label={t('smsAriaLabel')} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="maxSmsPerDay">{t('maxSmsPerDayLabel')}</Label>
        <Input
          id="maxSmsPerDay"
          name="maxSmsPerDay"
          type="number"
          min="0"
          step="1"
          defaultValue={settings.maxSmsPerDay}
          required
          className="max-w-[10rem]"
        />
        <p className="text-xs text-neutral-500">{t('maxSmsPerDayHint')}</p>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && <p className="text-sm text-success">{t('saved')}</p>}
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? t('saving') : t('save')}
      </Button>
    </form>
  );
}
