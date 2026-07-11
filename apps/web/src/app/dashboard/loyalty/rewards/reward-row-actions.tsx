'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toggleRewardStatusAction, deleteRewardAction } from '@/lib/actions/loyalty';
import { Button } from '@/components/ui';

export function RewardRowActions({ rewardId, status }: { rewardId: string; status: 'active' | 'inactive' }) {
  const [pending, startTransition] = useTransition();
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.staff.rewardActions');

  const handleToggle = () => {
    startTransition(async () => {
      await toggleRewardStatusAction(rewardId, status === 'active' ? 'inactive' : 'active');
    });
  };

  const handleDelete = () => {
    const confirmed = confirm(t('deleteConfirm'));
    if (!confirmed) return;

    startTransition(async () => {
      try {
        await deleteRewardAction(rewardId);
      } catch {
        alert(t('deleteFailedAlert'));
      }
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={handleToggle} disabled={pending}>
        {status === 'active' ? t('deactivate') : t('activate')}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={handleDelete} disabled={pending}>
        {t('delete')}
      </Button>
    </div>
  );
}
