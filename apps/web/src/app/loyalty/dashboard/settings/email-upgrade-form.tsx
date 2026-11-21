'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Label } from '@/components/ui';
import { requestCustomerEmailUpgradeAction, type CustomerEmailUpgradeState } from '@/lib/actions/customer-email-upgrade';

const initial: CustomerEmailUpgradeState = {};
const reverify = '/loyalty/login?method=phone&next=%2Floyalty%2Fdashboard%2Fsettings';

/** Existing phone-only accounts must first authenticate by a FRESH phone OTP. */
export function CustomerEmailUpgradeForm({ canUpgrade }: { canUpgrade: boolean }) {
  const [state, formAction, pending] = useActionState(requestCustomerEmailUpgradeAction, initial);
  const t = useTranslations('loyalty.customer.settings');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-700">{t('upgradeDescription')}</p>
      {!canUpgrade || state.error === 'verify_phone_again' ? (
        <Link href={reverify} className="text-sm font-medium text-brand-700 underline">{t('upgradeVerifyPhone')}</Link>
      ) : state.sent ? (
        <p role="status" className="text-sm text-brand-700">{t('upgradeSent')}</p>
      ) : (
        <form action={formAction} className="flex flex-col gap-3">
          <Label htmlFor="upgrade-email">{t('upgradeEmailLabel')}</Label>
          <Input id="upgrade-email" name="email" type="email" autoComplete="email" required />
          {state.error && <p role="alert" className="text-sm text-danger">{t('upgradeErrors.' + state.error)}</p>}
          <Button type="submit" disabled={pending}>{pending ? t('saving') : t('upgradeRequest')}</Button>
        </form>
      )}
    </div>
  );
}
