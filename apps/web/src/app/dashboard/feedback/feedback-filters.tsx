'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FEEDBACK_CATEGORIES, URGENCY_LEVELS } from '@echo-grid-feedback/shared-types';

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
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="feedback-search" className="text-xs font-medium text-neutral-600">
          {t('searchLabel')}
        </label>
        <input
          id="feedback-search"
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="h-9 w-56 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="feedback-category" className="text-xs font-medium text-neutral-600">
          {t('categoryFilterLabel')}
        </label>
        <select
          id="feedback-category"
          multiple
          value={categoryInput}
          onChange={(e) => setCategoryInput(selectValues(e))}
          aria-describedby="feedback-multiselect-hint"
          className="h-24 w-48 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {FEEDBACK_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`categories.${c}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="feedback-urgency" className="text-xs font-medium text-neutral-600">
          {t('urgencyFilterLabel')}
        </label>
        <select
          id="feedback-urgency"
          multiple
          value={urgencyInput}
          onChange={(e) => setUrgencyInput(selectValues(e))}
          aria-describedby="feedback-multiselect-hint"
          className="h-24 w-40 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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

      <div className="flex gap-2">
        <button
          type="submit"
          className="h-9 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {t('search')}
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="h-9 rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {t('clearFilters')}
        </button>
      </div>
    </form>
  );
}
