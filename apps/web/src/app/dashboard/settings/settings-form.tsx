'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { SUPPORTED_LOCALES, LOCALE_LABELS, type BusinessDto } from '@echo-grid-feedback/shared-types';
import {
  updateBusinessSettingsAction,
  type BusinessSettingsFormState,
} from '@/lib/actions/business';
import { COMMON_CURRENCIES } from '@/lib/currencies';
import { Button, Input, Label, Select } from '@/components/ui';

const initialState: BusinessSettingsFormState = {};

export function SettingsForm({ business }: { business: BusinessDto }) {
  const [state, formAction, pending] = useActionState(updateBusinessSettingsAction, initialState);
  // i18n & Multi-Currency Block 4. LOCALE_LABELS is deliberately NOT run
  // through t() -- each language's name is shown in that language's own
  // script (e.g. "Français" even for an English-viewing admin), the same
  // convention every real-world language switcher uses, not a translated
  // string this component owns.
  const t = useTranslations('dashboard.settings');

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">{t('nameLabel')}</Label>
        <Input id="name" name="name" defaultValue={business.name} required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultLocale">{t('languageLabel')}</Label>
          <Select id="defaultLocale" name="defaultLocale" defaultValue={business.defaultLocale} required>
            {SUPPORTED_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {LOCALE_LABELS[locale]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultCurrency">{t('currencyLabel')}</Label>
          <Select
            id="defaultCurrency"
            name="defaultCurrency"
            defaultValue={business.defaultCurrency}
            required
          >
            {COMMON_CURRENCIES.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultTimezone">{t('timezoneLabel')}</Label>
          <Input
            id="defaultTimezone"
            name="defaultTimezone"
            defaultValue={business.defaultTimezone}
            placeholder="America/New_York"
            required
          />
          <p className="text-xs text-neutral-500">{t('timezoneHint')}</p>
        </div>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && <p className="text-sm text-success">{t('success')}</p>}
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? t('submitPending') : t('submit')}
      </Button>
    </form>
  );
}
