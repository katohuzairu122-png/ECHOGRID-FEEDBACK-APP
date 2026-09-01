'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toggleRewardStatusAction, deleteRewardAction } from '@/lib/actions/loyalty';
import { Button } from '@/components/ui';

// CI fix (Block 6.6): loyaltyRewardSchema's status widened to include
// 'paused' (matching the DB CHECK constraint since Block 6.1). The prop
// type here accepts all three values reward.status can genuinely carry.
//
// Continuing Development Block 6.8.2 update: 'paused' stopped being
// theoretical -- RewardFormDialog's edit-only status <select> can now set
// it, so this component's own "nothing produces this state yet" reasoning
// (the version of this comment before Block 6.8.2) no longer holds. The
// toggle button's behavior is UNCHANGED by that: it still only offers
// active<->inactive (status === 'active' ? 'inactive' : 'active'), which
// already does the right thing on a paused row -- not currently active, so
// the button correctly reads "Activate" and correctly reactivates it on
// click. Left as-is rather than adding a three-way cycle or a distinct
// "Resume" label: the edit dialog is now the deliberate, explicit place to
// pause a reward, and this quick-action button's job stays the fast common
// case, same scope it already had. The one cosmetic loose end -- a paused
// row's badge (rewards/page.tsx) is now visually distinct from inactive,
// but this button still just says "Activate" for both -- is noted here
// rather than silently left for a future reader to puzzle out; picking it
// up isn't required for Block 6.8.2's own scope.
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
