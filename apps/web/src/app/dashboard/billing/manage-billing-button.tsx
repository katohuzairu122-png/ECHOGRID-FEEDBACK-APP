'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createPortalSessionAction, type BillingActionState } from '@/lib/actions/billing';
import { Button } from '@/components/ui';

const initialState: BillingActionState = {};

/** Only rendered when subscription.hasPaymentAccount is true (page.tsx) --
 * a business still on its card-less trial has no Stripe Customer Portal to
 * open yet (billing.service.ts's createPortalSession would 422). */
export function ManageBillingButton() {
  const t = useTranslations('dashboard.billing');
  const [state, formAction, pending] = useActionState(createPortalSessionAction, initialState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? t('openingPortal') : t('manageBilling')}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
