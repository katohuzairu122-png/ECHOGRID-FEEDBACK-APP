'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { deleteTierAction } from '@/lib/actions/loyalty';
import { Button } from '@/components/ui';

/** Mirrors DeleteBranchButton's confirm()-then-startTransition pattern exactly. */
export function DeleteTierButton({ tierId, tierName }: { tierId: string; tierName: string }) {
  const [pending, startTransition] = useTransition();
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.staff.deleteTier');

  const handleDelete = () => {
    const confirmed = confirm(t('confirm', { name: tierName }));
    if (!confirmed) return;

    startTransition(async () => {
      try {
        await deleteTierAction(tierId);
      } catch {
        alert(t('failedAlert'));
      }
    });
  };

  return (
    <Button type="button" variant="ghost" size="sm" onClick={handleDelete} disabled={pending}>
      {t('button')}
    </Button>
  );
}
