'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { leaveLoyaltyAction } from '@/lib/actions/loyalty-customer';
import { Button } from '@/components/ui';

interface LeaveMembershipProps {
  businessId: string;
  businessName: string;
}

/**
 * The customer ends their own membership. Two steps in place (no dialog, like the rest of this page's
 * inline confirmations): the button reveals what leaving means, and only "Yes, leave" calls the API.
 * What it means is spelled out because it is a consent withdrawal, not just a hide: earning and
 * redeeming stop, the consent to join is withdrawn, and the points are kept for a later re-join.
 */
export function LeaveMembership({ businessId, businessName }: LeaveMembershipProps) {
  const t = useTranslations('loyalty.customer.businessDashboard.membership');
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function leave() {
    setFailed(false);
    startTransition(async () => {
      try {
        const result = await leaveLoyaltyAction(businessId);
        if (result.left) {
          router.refresh();
        } else {
          setFailed(true);
        }
      } catch {
        setFailed(true);
      }
    });
  }

  if (!confirming) {
    return (
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          {t('leaveButton')}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('leaveButton')}
      className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
    >
      <p className="text-sm text-neutral-700">{t('leavePrompt', { business: businessName })}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="danger" size="sm" disabled={pending} onClick={leave}>
          {pending ? t('leaving') : t('leaveConfirm')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setFailed(false);
          }}
        >
          {t('leaveCancel')}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-danger">
          {t('leaveError')}
        </p>
      )}
    </div>
  );
}
