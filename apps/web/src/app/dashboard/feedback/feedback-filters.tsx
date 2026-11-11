'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FEEDBACK_CATEGORIES, URGENCY_LEVELS } from '@echo-grid-feedback/shared-types';
import { Button } from '@/components/ui';
import styles from './feedback-inbox.module.css';

interface FeedbackFiltersProps {
  search?: string | undefined;
  category: string[];
  urgency: string[];
  /** Every other active param (branchId, savedView, etc.) to preserve on
   * submit -- this form only ever touches search/category/urgency. */
  baseParams: Record<string, string>;
}

/**
 * Native <select multiple>, not a custom multi-select widget -- same
 * "no Combobox primitive exists yet, and a native control is fully
 * accessible/keyboard-operable without waiting on one" reasoning as
 * BranchFilter. Submitted together (Search button), not per-change, since
 * three fields changing independently would otherwise fire three
 * navigations for one user intent.
 */
export function FeedbackFilters({ search, category, urgency, baseParams }: FeedbackFiltersProps) {
  const router = useRouter();
  const t = useTranslations('feedback.staff');
  const [searchInput, setSearchInput] = useState(search ?? '');
  const [categoryInput, setCategoryInput] = useState<string[]>(category);
  const [urgencyInput, setUrgencyInput] = useState<string[]>(urgency);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams(baseParams);
    params.delete('offset'); // a new filter always starts back at page 1
    if (searchInput) params.set('search', searchInput);
    else params.delete('search');
    params.delete('category');
    categoryInput.forEach((c) => params.append('category', c));
    params.delete('urgency');
    urgencyInput.forEach((u) => params.append('urgency', u));
    router.push(`/dashboard/feedback?${params}`);
  };

  const handleClear = () => {
    const params = new URLSearchParams(baseParams);
    params.delete('offset');
    params.delete('search');
    params.delete('category');
    params.delete('urgency');
    router.push(`/dashboard/feedback?${params}`);
  };

  const selectValues = (e: FormEvent<HTMLSelectElement>) =>
    Array.from(e.currentTarget.selectedOptions, (o) => o.value);

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
          className="border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="feedback-category">{t('categoryFilterLabel')}</label>
        <select
          id="feedback-category"
          multiple
          value={categoryInput}
          onChange={(e) => setCategoryInput(selectValues(e))}
          aria-describedby="feedback-multiselect-hint"
          className="border border-neutral-300 bg-white text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
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
          multiple
          value={urgencyInput}
          onChange={(e) => setUrgencyInput(selectValues(e))}
          aria-describedby="feedback-multiselect-hint"
          className="border border-neutral-300 bg-white text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {URGENCY_LEVELS.map((u) => (
            <option key={u} value={u}>
              {t(`urgency.${u}`)}
            </option>
          ))}
        </select>
      </div>

      <p id="feedback-multiselect-hint" className="sr-only">
        {t('multiSelectHint')}
      </p>

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
