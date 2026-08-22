'use client';

import { useState, useTransition } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import type { FeedbackDto } from '@echo-grid-feedback/shared-types';
import { bulkAssignToMeAction, bulkMarkReviewedAction } from '@/lib/actions/feedback';
import { FeedbackActions } from './feedback-actions';
import { Badge, Card, CardContent, StarDisplay } from '@/components/ui';

const URGENCY_VARIANT: Record<string, 'danger' | 'warning' | 'neutral'> = {
  P0_CRITICAL: 'danger',
  P1_HIGH: 'warning',
  P2_NORMAL: 'neutral',
  P3_LOW: 'neutral',
};

interface FeedbackInboxListProps {
  items: FeedbackDto[];
  branchNames: Map<string, string>;
  currentUserId?: string | undefined;
}

/**
 * Owns bulk-selection state (a Set of ids) and renders the whole card list
 * plus the floating bulk-action bar -- one client component rather than
 * scattering selection state across N per-card components, since "select
 * all" and "N selected" both need to see every row's state at once.
 * Per-row mark-reviewed/delete stay delegated to FeedbackActions
 * (unchanged) since those are single-row actions with no bearing on
 * selection.
 */
export function FeedbackInboxList({ items, branchNames, currentUserId }: FeedbackInboxListProps) {
  const t = useTranslations('feedback.staff');
  const format = useFormatter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)));
  };

  const handleBulkAssign = () => {
    const ids = Array.from(selected);
    startTransition(async () => {
      await bulkAssignToMeAction(ids);
      setSelected(new Set());
    });
  };

  const handleBulkReview = () => {
    const ids = Array.from(selected);
    startTransition(async () => {
      await bulkMarkReviewedAction(ids);
      setSelected(new Set());
    });
  };

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 border-b border-neutral-200 pb-2">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          aria-label={t('selectAllAriaLabel')}
          className="size-4 rounded border-neutral-300 text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        />
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-neutral-600">{t('selectedCount', { count: selected.size })}</span>
            <button
              type="button"
              onClick={handleBulkAssign}
              disabled={pending}
              className="h-8 rounded-md border border-neutral-300 px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {t('bulkAssignToMe')}
            </button>
            <button
              type="button"
              onClick={handleBulkReview}
              disabled={pending}
              className="h-8 rounded-md border border-neutral-300 px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {t('bulkMarkReviewed')}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={pending}
              className="h-8 rounded-md px-3 text-xs font-medium text-neutral-500 hover:bg-neutral-50 disabled:opacity-50"
            >
              {t('clearSelection')}
            </button>
          </div>
        )}
      </div>

      {items.map((item) => (
        <Card key={item.id}>
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggleOne(item.id)}
                  aria-label={t('selectRowAriaLabel', {
                    rating: item.rating,
                    date: format.dateTime(new Date(item.createdAt), 'short'),
                  })}
                  className="mt-1 size-4 shrink-0 rounded border-neutral-300 text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                />
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StarDisplay value={item.rating} />
                    <Badge variant={item.status === 'new' ? 'accent' : 'neutral'}>
                      {item.status === 'new' ? t('statusNew') : t('statusReviewed')}
                    </Badge>
                    {item.urgency && (
                      <Badge variant={URGENCY_VARIANT[item.urgency] ?? 'neutral'}>{t(`urgency.${item.urgency}`)}</Badge>
                    )}
                    {item.category && <Badge variant="neutral">{t(`categories.${item.category}`)}</Badge>}
                    {item.assignedTo && (
                      <Badge variant="brand">{item.assignedTo === currentUserId ? t('assignedToMe') : t('assigned')}</Badge>
                    )}
                  </div>
                  <p className="text-xs text-neutral-500">
                    {branchNames.get(item.branchId) ?? t('unknownBranch')} ·{' '}
                    {format.dateTime(new Date(item.createdAt), 'short')}
                  </p>
                </div>
              </div>
              <FeedbackActions feedbackId={item.id} status={item.status} />
            </div>

            {item.comment && <p className="text-sm text-neutral-800">{item.comment}</p>}

            {item.followUpQuestion && item.followUpAnswer && (
              <div className="rounded-md bg-neutral-50 p-3">
                <p className="text-xs font-medium text-neutral-500">{item.followUpQuestion}</p>
                <p className="text-sm text-neutral-800">{item.followUpAnswer}</p>
              </div>
            )}

            {(item.customerName || item.customerEmail || item.customerPhone) && (
              <p className="text-xs text-neutral-500">
                {[item.customerName, item.customerEmail, item.customerPhone].filter(Boolean).join(' · ')}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
