'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { updateCustomerProfileAction, type CustomerProfileFormState } from '@/lib/actions/customer-profile';
import { Button, Input, Label } from '@/components/ui';

const initial: CustomerProfileFormState = {};

export function CustomerProfileForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(updateCustomerProfileAction, initial);
  const t = useTranslations('loyalty.customer.settings');
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="customer-name">{t('nameLabel')}</Label>
        <Input id="customer-name" name="name" defaultValue={name} autoComplete="name" maxLength={120} required />
      </div>
      {state.error && <p role="alert" className="text-sm text-danger">{t(`errors.${state.error}`)}</p>}
      {state.saved && <p role="status" className="text-sm text-green-700">{t('saved')}</p>}
      <Button type="submit" disabled={pending}>{pending ? t('saving') : t('save')}</Button>
    </form>
  );
}
