'use client';

import { useActionState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { LoyaltySettingsDto } from '@echo-grid-feedback/shared-types';
import { updateSettingsAction, type LoyaltyFormState } from '@/lib/actions/loyalty';
import { Button, Input, Label } from '@/components/ui';

const initialState: LoyaltyFormState = {};

interface SettingsFormProps {
  settings: LoyaltySettingsDto;
  /** Business's defaultCurrency (i18n & Multi-Currency Block 3) -- passed
   * down from settings/page.tsx's Server Component, which already has the
   * active business in hand, rather than this Client Component fetching
   * its own copy. */
  currency: string;
}

export function SettingsForm({ settings, currency }: SettingsFormProps) {
  const [state, formAction, pending] = useActionState(updateSettingsAction, initialState);
  const format = useFormatter();
  // i18n & Multi-Currency Block 6 (Block 3 introduced the currency-aware
  // label itself; this block translates the rest of the form around it).
  const t = useTranslations('loyalty.staff.settings');
  // Renders "1.00 €"/"$1.00"/etc. correctly positioned for the request
  // locale instead of a hardcoded "$1" -- style: 'currency' still requires
  // a real ISO 4217 code (validated at the API, see updateBusinessSchema),
  // ambiguous/placeholder currencies aren't a real Intl concept.
  const oneUnit = format.number(1, { style: 'currency', currency });

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pointsPerCheckin">{t('pointsPerCheckinLabel')}</Label>
          <Input
            id="pointsPerCheckin"
            name="pointsPerCheckin"
            type="number"
            min="0"
            step="1"
            defaultValue={settings.pointsPerCheckin}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pointsPerCurrencyUnit">
            {t('pointsPerCurrencyLabel', { currency: oneUnit })}
          </Label>
          <Input
            id="pointsPerCurrencyUnit"
            name="pointsPerCurrencyUnit"
            type="number"
            min="0"
            step="0.01"
            defaultValue={settings.pointsPerCurrencyUnit}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="referralBonusPoints">{t('referralBonusLabel')}</Label>
          <Input
            id="referralBonusPoints"
            name="referralBonusPoints"
            type="number"
            min="0"
            step="1"
            defaultValue={settings.referralBonusPoints}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="birthdayBonusPoints">{t('birthdayBonusLabel')}</Label>
          <Input
            id="birthdayBonusPoints"
            name="birthdayBonusPoints"
            type="number"
            min="0"
            step="1"
            defaultValue={settings.birthdayBonusPoints}
            required
          />
        </div>
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
