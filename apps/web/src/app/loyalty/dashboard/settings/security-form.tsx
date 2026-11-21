'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Label } from '@/components/ui';
import {
  changeCustomerPasswordAction,
  logoutCustomerEverywhereAction,
  type CustomerPasswordChangeState,
} from '@/lib/actions/customer-profile';

const initial: CustomerPasswordChangeState = {};

export function CustomerSecurityForm({ canManageSessions }: { canManageSessions: boolean }) {
  const [state, action, pending] = useActionState(changeCustomerPasswordAction, initial);
  const t = useTranslations('loyalty.customer.settings');
  return (
    <div className="flex flex-col gap-6">
      <form action={action} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="current-password">{t('currentPasswordLabel')}</Label>
          <Input id="current-password" type="password" name="currentPassword" autoComplete="current-password" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-password">{t('newPasswordLabel')}</Label>
          <Input id="new-password" type="password" name="newPassword" autoComplete="new-password" minLength={8} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm-new-password">{t('confirmPasswordLabel')}</Label>
          <Input id="confirm-new-password" type="password" name="confirmPassword" autoComplete="new-password" minLength={8} required />
        </div>
        {state.error && <p role="alert" className="text-sm text-danger">{t(`errors.${state.error}`)}</p>}
        <Button type="submit" disabled={pending}>{pending ? t('saving') : t('changePassword')}</Button>
      </form>
      {canManageSessions && (
        <form action={logoutCustomerEverywhereAction}>
          <Button type="submit" variant="outline">{t('logoutEverywhere')}</Button>
        </form>
      )}
    </div>
  );
}
