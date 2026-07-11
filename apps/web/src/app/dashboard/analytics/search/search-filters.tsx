'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { BranchDto } from '@echo-grid-feedback/shared-types';
import { Button } from '@/components/ui';

interface SearchFiltersProps {
  branches: BranchDto[];
  branchId?: string;
  sentiment?: string;
  rating?: string;
  keyword?: string;
  range?: string;
}

/** Keyed by the same range value the URL/query string uses, so the
 * translation lookup ('range7'/'range30'/etc.) is a direct string
 * concatenation rather than a second parallel mapping (i18n & Multi-Currency
 * Block 7). */
const RANGE_OPTIONS = [
  { value: '7', key: 'range7' },
  { value: '30', key: 'range30' },
  { value: '90', key: 'range90' },
  { value: '365', key: 'range365' },
] as const;

/**
 * One combined filter bar (branch/sentiment/rating/keyword/range) submitted
 * together on Search, not several independently-navigating selects like
 * BranchFilter's single-field pattern -- with this many fields, applying
 * one at a time would make each change clobber the others mid-edit. The
 * URL stays the single source of truth (consistent with every other filter
 * in this app), and offset is deliberately dropped on every new search --
 * a stale page-2 offset combined with a materially different result set
 * wouldn't be a real "page 2 of this search."
 */
export function SearchFilters({ branches, branchId, sentiment, rating, keyword, range }: SearchFiltersProps) {
  const router = useRouter();
  const [branchInput, setBranchInput] = useState(branchId ?? '');
  const [sentimentInput, setSentimentInput] = useState(sentiment ?? '');
  const [ratingInput, setRatingInput] = useState(rating ?? '');
  const [keywordInput, setKeywordInput] = useState(keyword ?? '');
  const [rangeInput, setRangeInput] = useState(range ?? '30');
  // i18n & Multi-Currency Block 7.
  const t = useTranslations('analytics.searchFilters');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (branchInput) params.set('branchId', branchInput);
    if (sentimentInput) params.set('sentiment', sentimentInput);
    if (ratingInput) params.set('rating', ratingInput);
    if (keywordInput) params.set('keyword', keywordInput);
    if (rangeInput) params.set('range', rangeInput);
    router.push(`/dashboard/analytics/search?${params}`);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <Field label={t('branchLabel')}>
        <select
          value={branchInput}
          onChange={(e) => setBranchInput(e.target.value)}
          className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <option value="">{t('allBranches')}</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('keywordLabel')}>
        <input
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          placeholder="e.g. slow service"
          className="h-9 w-48 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
      </Field>

      <Field label={t('sentimentLabel')}>
        <select
          value={sentimentInput}
          onChange={(e) => setSentimentInput(e.target.value)}
          className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <option value="">{t('any')}</option>
          <option value="positive">{t('positive')}</option>
          <option value="neutral">{t('neutral')}</option>
          <option value="negative">{t('negative')}</option>
        </select>
      </Field>

      <Field label={t('ratingLabel')}>
        <select
          value={ratingInput}
          onChange={(e) => setRatingInput(e.target.value)}
          className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <option value="">{t('any')}</option>
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? t('starSingular', { n }) : t('starPlural', { n })}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('rangeLabel')}>
        <select
          value={rangeInput}
          onChange={(e) => setRangeInput(e.target.value)}
          className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {RANGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.key)}
            </option>
          ))}
        </select>
      </Field>

      <Button type="submit" size="sm">
        {t('search')}
      </Button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600">{label}</span>
      {children}
    </label>
  );
}
