'use client';

import { useState, useTransition } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import { sentimentPolarity, type FeedbackDto } from '@echo-grid-feedback/shared-types';
import { bulkAssignToMeAction, bulkMarkReviewedAction } from '@/lib/actions/feedback';
import { FeedbackActions } from './feedback-actions';
import { Badge, StarDisplay } from '@/components/ui';
import styles from './feedback-inbox.module.css';

const URGENCY_VARIANT: Record<string, 'danger' | 'warning' | 'neutral'> = {
  P0_CRITICAL: 'danger',
  P1_HIGH: 'warning',
  P2_NORMAL: 'neutral',
  P3_LOW: 'neutral',
};

// Sentiment polarity -> badge tone. Only the API's own classification is shown; null/'unknown' gets no badge.
const POLARITY_VARIANT = { positive: 'success', neutral: 'neutral', negative: 'danger' } as const;

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
    <div className="flex flex-col gap-4">
      <div className={styles.listHead}>
        <label className={styles.selectAll}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            aria-label={t('selectAllAriaLabel')}
            className={styles.checkbox}
          />
          <span aria-hidden="true">{t('selectAllAriaLabel')}</span>
        </label>
        <p className={styles.count}>{t('showingCount', { count: items.length })}</p>
      </div>

      <ul className={styles.list}>
        {items.map((item) => {
          const polarity = sentimentPolarity(item.sentiment);
          const isSelected = selected.has(item.id);
          return (
            <li key={item.id}>
              <article
                className={styles.card}
                data-selected={isSelected}
                data-status={item.status}
                {...(item.urgency ? { 'data-urgency': item.urgency } : {})}
              >
                <div className={styles.cardTop}>
                  <div className={styles.cardLead}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(item.id)}
                      aria-label={t('selectRowAriaLabel', {
                        rating: item.rating,
                        date: format.dateTime(new Date(item.createdAt), 'short'),
                      })}
                      className={styles.checkbox}
                    />
                    <div className="min-w-0">
                      <div className={styles.rating}>
                        <StarDisplay value={item.rating} />
                        <span aria-hidden="true">{t('ratingOutOf', { rating: item.rating })}</span>
                      </div>
                      <div className={styles.badges}>
                        <Badge variant={item.status === 'new' ? 'accent' : 'neutral'}>
                          <span className="sr-only">{t('fieldStatus')} </span>
                          {item.status === 'new' ? t('statusNew') : t('statusReviewed')}
                        </Badge>
                        {item.urgency && (
                          <Badge variant={URGENCY_VARIANT[item.urgency] ?? 'neutral'}>
                            <span className="sr-only">{t('fieldUrgency')} </span>
                            {t(`urgency.${item.urgency}`)}
                          </Badge>
                        )}
                        {item.sentiment && polarity ? (
                          <Badge variant={POLARITY_VARIANT[polarity]}>
                            <span className="sr-only">{t('fieldSentiment')} </span>
                            {t(`sentiment.${item.sentiment as 'positive'}`)}
                          </Badge>
                        ) : item.analysisStatus === 'pending' ? (
                          <Badge variant="neutral">{t('analysisPending')}</Badge>
                        ) : item.analysisStatus === 'failed' ? (
                          <Badge variant="warning">{t('analysisFailed')}</Badge>
                        ) : null}
                        {item.category && (
                          <Badge variant="neutral">
                            <span className="sr-only">{t('fieldCategory')} </span>
                            {t(`categories.${item.category}`)}
                          </Badge>
                        )}
                        {item.assignedTo && (
                          <Badge variant="brand">
                            {item.assignedTo === currentUserId ? t('assignedToMe') : t('assigned')}
                          </Badge>
                        )}
                      </div>
                      <p className={styles.meta}>
                        {branchNames.get(item.branchId) ?? t('unknownBranch')} ·{' '}
                        <time dateTime={item.createdAt}>
                          {format.dateTime(new Date(item.createdAt), 'short')}
                        </time>
                      </p>
                    </div>
                  </div>
                  <FeedbackActions feedbackId={item.id} status={item.status} />
                </div>

                {item.comment && <p className={styles.comment}>{item.comment}</p>}

                {item.followUpQuestion && item.followUpAnswer && (
                  <div className={styles.followUp}>
                    <p>{item.followUpQuestion}</p>
                    <p className="text-sm">{item.followUpAnswer}</p>
                  </div>
                )}

                {(item.customerName || item.customerEmail || item.customerPhone) && (
                  <p className={styles.customer}>
                    {[item.customerName, item.customerEmail, item.customerPhone]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </article>
            </li>
          );
        })}
      </ul>

      {selected.size > 0 && (
        <div
          className={styles.bulkBar}
          role="region"
          aria-label={t('selectedCount', { count: selected.size })}
        >
          <span aria-live="polite">{t('selectedCount', { count: selected.size })}</span>
          <button
            type="button"
            onClick={handleBulkAssign}
            disabled={pending}
            className={styles.secondaryButton}
          >
            {t('bulkAssignToMe')}
          </button>
          <button
            type="button"
            onClick={handleBulkReview}
            disabled={pending}
            className={styles.secondaryButton}
          >
            {t('bulkMarkReviewed')}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={pending}
            className={styles.ghostButton}
          >
            {t('clearSelection')}
          </button>
        </div>
      )}
    </div>
  );
}
