'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { markReviewedAction, deleteFeedbackAction } from '@/lib/actions/feedback';
import { Button } from '@/components/ui';

interface FeedbackActionsProps {
  feedbackId: string;
  status: 'new' | 'reviewed';
}

/**
 * Delete mirrors DeleteBranchButton's confirm()-then-startTransition
 * pattern exactly. Mark-reviewed gets NO confirmation -- much lower stakes
 * than delete (no data loss; the content stays fully visible either way,
 * just visually deprioritized), consistent with only genuinely
 * hard-to-undo actions getting a confirm() gate in this app.
 */
export function FeedbackActions({ feedbackId, status }: FeedbackActionsProps) {
  const [pending, startTransition] = useTransition();
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('feedback.staff');

  const handleMarkReviewed = () => {
    startTransition(async () => {
      await markReviewedAction(feedbackId);
    });
  };

  const handleDelete = () => {
    const confirmed = confirm(t('deleteConfirm'));
    if (!confirmed) return;

    startTransition(async () => {
      try {
        await deleteFeedbackAction(feedbackId);
      } catch {
        alert(t('deleteFailedAlert'));
      }
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      {status === 'new' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleMarkReviewed}
          disabled={pending}
        >
          {pending ? t('working') : t('markReviewed')}
        </Button>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={handleDelete} disabled={pending}>
        {t('delete')}
      </Button>
    </div>
  );
}
