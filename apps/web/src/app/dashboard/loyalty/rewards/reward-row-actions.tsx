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
// toggle button's CLICK behavior is unchanged by that: it still only sends
// active<->inactive (status === 'active' ? 'inactive' : 'active'), which
// already does the right thing on a paused row -- not currently active, so
// clicking it correctly reactivates to 'active'. Still no three-way cycle:
// the edit dialog stays the deliberate, explicit place to pause a reward,
// and this quick-action button's job stays the fast common case.
//
// Block 6.8.5 (i18n/polish pass) closed the one loose end 6.8.2 flagged
// and deliberately deferred: the LABEL now distinguishes a paused row
// ("Resume") from an inactive one ("Activate") below, matching the badge
// (rewards/page.tsx) already being visually distinct between the two
// since 6.8.2. Click behavior is identical either way -- this is a label
// fix only, not a new code path.
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
        {status === 'active' ? t('deactivate') : status === 'paused' ? t('resume') : t('activate')}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={handleDelete} disabled={pending}>
        {t('delete')}
      </Button>
    </div>
  );
}
