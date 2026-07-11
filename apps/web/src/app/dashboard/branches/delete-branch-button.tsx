'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { deleteBranchAction } from '@/lib/actions/branches';
import { Button } from '@/components/ui';

/**
 * Native confirm() rather than a custom Dialog -- a reasonable, zero-
 * dependency choice for a single yes/no gate on a destructive action.
 * Worth upgrading to a shared <ConfirmDialog> (built on the Dialog
 * primitive) if a future block wants more polish or a typed-confirmation
 * step for higher-stakes deletes.
 */
export function DeleteBranchButton({
  branchId,
  branchName,
}: {
  branchId: string;
  branchName: string;
}) {
  const [pending, startTransition] = useTransition();
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('branches.delete');

  const handleDelete = () => {
    const confirmed = confirm(t('confirm', { name: branchName }));
    if (!confirmed) return;

    startTransition(async () => {
      try {
        await deleteBranchAction(branchId);
      } catch {
        alert(t('failedAlert'));
      }
    });
  };

  return (
    <Button type="button" variant="ghost" size="sm" onClick={handleDelete} disabled={pending}>
      {pending ? t('deleting') : t('button')}
    </Button>
  );
}
