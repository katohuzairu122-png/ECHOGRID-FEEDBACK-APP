'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { restoreCustomerDeletionAction, type CustomerDeletionState } from '@/lib/actions/customer-deletion';

const initial: CustomerDeletionState = {};

export function CustomerDeletionRestoreForm() {
  const [state, action, pending] = useActionState(restoreCustomerDeletionAction, initial);
  const t = useTranslations('loyalty.customer.accountDeletion');
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.error && <p role="alert" className="text-sm text-danger">
        {t(`errors.${state.error}`)}
      </p>}
      <Button type="submit" disabled={pending}>
        {pending ? t('working') : t('restore')}
      </Button>
    </form>
  );
}
