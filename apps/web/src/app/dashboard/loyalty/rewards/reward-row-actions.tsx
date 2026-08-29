'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toggleRewardStatusAction, deleteRewardAction } from '@/lib/actions/loyalty';
import { Button } from '@/components/ui';

// CI fix (Block 6.6): loyaltyRewardSchema's status widened to include
// 'paused' (matching the DB CHECK constraint since Block 6.1), but
// LoyaltyRewardService.UpdateRewardInput.status is deliberately still
// 'active' | 'inactive' only -- see loyalty-rewards.ts's scoping decision
// 4: nothing can set a reward to 'paused' through the app yet, only a
// future direct write. The prop type here just needs to accept the value
// reward.status can now genuinely carry; the toggle keeps its existing
// binary active/inactive behavior unchanged (a paused row falls into the
// same "show Activate" branch as inactive) rather than inventing new UI
// for a state nothing else in the app produces yet.
export function RewardRowActions({
  rewardId,
  status,
}: {
  rewardId: string;
  status: 'active' | 'inactive' | 'paused';
}) {
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
