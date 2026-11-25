'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Label } from '@/components/ui';
import { requestCustomerDeletionAction, type CustomerDeletionState } from '@/lib/actions/customer-deletion';

const initial: CustomerDeletionState = {};

export function CustomerDeletionRequestForm() {
  const [state, action, pending] = useActionState(requestCustomerDeletionAction, initial);
  const t = useTranslations('loyalty.customer.accountDeletion');
  return (
    <form action={action} className="flex flex-col gap-4">
      <p className="text-sm text-neutral-700">{t('explanation')}</p>
      <p className="text-sm text-neutral-700">{t('retainedData')}</p>
      <p className="text-sm text-neutral-700">{t('operatorNotice')}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="deletion-password">{t('password')}</Label>
        <Input id="deletion-password" type="password" name="currentPassword"
          autoComplete="current-password" maxLength={1024} required />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" value="yes" required />
        <span>{t('confirm')}</span>
      </label>
      {state.error && <p role="alert" className="text-sm text-danger">
        {t(`errors.${state.error}`)}
      </p>}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? t('working') : t('request')}
      </Button>
    </form>
  );
}
