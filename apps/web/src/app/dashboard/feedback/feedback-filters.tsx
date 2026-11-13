'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FEEDBACK_CATEGORIES, URGENCY_LEVELS } from '@echo-grid-feedback/shared-types';
import { Button } from '@/components/ui';
import styles from './feedback-inbox.module.css';

/** Saved views, in the order the old tab row showed them. */
export const SAVED_VIEWS = [
  'critical_now',
  'high_priority_unresolved',
  'negative_unresolved',
  'follow_up_required',
  'unclassified',
  'recently_resolved',
  'positive_feedback',
  // Continuing Development S5-B. Last on purpose: a specialist triage view,
  // not part of the everyday sentiment/urgency sweep the views before it cover.
  'suspected_fraud',
] as const;

interface FeedbackFiltersProps {
  search?: string | undefined;
  savedView?: string | undefined;
  category: string[];
  urgency: string[];
  /** Every other active param (branchId, etc.) to preserve on change -- this
   * form only ever touches search, view, category and urgency. */
  baseParams: Record<string, string>;
}

const SELECT_CLASS =
  'border border-neutral-300 bg-white text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/**
 * One row of native dropdowns (view, category, urgency) plus the search box.
 * A dropdown applies as soon as it changes, because each is a single choice;
 * the comment search still needs its Search button (or Enter) so typing does
 * not navigate on every keystroke. The URL stays the source of truth, so the
 * filtered inbox is still a shareable, bookmarkable Server Component fetch.
 *
 * The server accepts several categories/urgencies. This control picks one; an
 * old bookmark with several shows the first and is replaced by a single choice
 * on the next change.
 */
export function FeedbackFilters({
  search,
  savedView,
  category,
  urgency,
  baseParams,
}: FeedbackFiltersProps) {
  const router = useRouter();
  const t = useTranslations('feedback.staff');
  const tViews = useTranslations('feedback.staff.savedViews');
  const [searchInput, setSearchInput] = useState(search ?? '');

  const go = (next: { savedView?: string; category?: string; urgency?: string }) => {
    const params = new URLSearchParams(baseParams);
    params.delete('offset'); // a new filter always starts back at page 1
    params.delete('search');
    params.delete('savedView');
    params.delete('category');
    params.delete('urgency');
    if (searchInput) params.set('search', searchInput);
    const view = next.savedView ?? savedView ?? '';
    const cat = next.category ?? category[0] ?? '';
    const urg = next.urgency ?? urgency[0] ?? '';
    if (view) params.set('savedView', view);
    if (cat) params.set('category', cat);
    if (urg) params.set('urgency', urg);
    const qs = params.toString();
    router.push(qs ? `/dashboard/feedback?${qs}` : '/dashboard/feedback');
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    go({});
  };

  const handleClear = () => {
    const params = new URLSearchParams(baseParams);
    params.delete('offset');
    params.delete('search');
    params.delete('savedView');
    params.delete('category');
    params.delete('urgency');
    const qs = params.toString();
    router.push(qs ? `/dashboard/feedback?${qs}` : '/dashboard/feedback');
  };

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
      aria-label={t('filtersLabel')}
      className={styles.filters}
    >
      <div className={styles.field}>
        <label htmlFor="feedback-search">{t('searchLabel')}</label>
        <input
          id="feedback-search"
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className={`${SELECT_CLASS} px-3`}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="feedback-view">{t('savedViewLabel')}</label>
        <select
          id="feedback-view"
          value={savedView ?? ''}
          onChange={(e) => go({ savedView: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">{tViews('all')}</option>
          {SAVED_VIEWS.map((v) => (
            <option key={v} value={v}>
              {tViews(v)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="feedback-category">{t('categoryFilterLabel')}</label>
        <select
          id="feedback-category"
          value={category[0] ?? ''}
          onChange={(e) => go({ category: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">{t('allCategories')}</option>
          {FEEDBACK_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`categories.${c}`)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="feedback-urgency">{t('urgencyFilterLabel')}</label>
        <select
          id="feedback-urgency"
          value={urgency[0] ?? ''}
          onChange={(e) => go({ urgency: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">{t('allUrgencies')}</option>
          {URGENCY_LEVELS.map((u) => (
            <option key={u} value={u}>
              {t(`urgency.${u}`)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.filterButtons}>
        <Button type="submit" className="min-h-11 rounded-xl px-5">
          {t('search')}
        </Button>
        <button type="button" onClick={handleClear} className={styles.secondaryButton}>
          {t('clearFilters')}
        </button>
      </div>
    </form>
  );
}
