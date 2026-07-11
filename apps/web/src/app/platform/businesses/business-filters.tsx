'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Input, Select } from '@/components/ui';

interface BusinessFiltersProps {
  search?: string;
  status?: string;
}

/**
 * One combined filter bar (search + status), submitted together -- mirrors
 * analytics/search/search-filters.tsx's reasoning exactly: with two fields,
 * applying one at a time would make each change clobber the other mid-edit.
 * URL stays the source of truth; offset is dropped on every new search, same
 * as that precedent -- a stale page-2 offset paired with a different result
 * set wouldn't be a real "page 2" of the new search.
 */
export function BusinessFilters({ search, status }: BusinessFiltersProps) {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState(search ?? '');
  const [statusInput, setStatusInput] = useState(status ?? '');
  const t = useTranslations('platform.businesses.filters');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (searchInput.trim()) params.set('search', searchInput.trim());
    if (statusInput) params.set('status', statusInput);
    router.push(`/platform/businesses?${params}`);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-600">{t('searchLabel')}</span>
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="w-56"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-600">{t('statusLabel')}</span>
        <Select value={statusInput} onChange={(e) => setStatusInput(e.target.value)} className="w-40">
          <option value="">{t('anyStatus')}</option>
          <option value="active">{t('statusActive')}</option>
          <option value="suspended">{t('statusSuspended')}</option>
          <option value="archived">{t('statusArchived')}</option>
        </Select>
      </label>
      <Button type="submit" size="sm">
        {t('apply')}
      </Button>
    </form>
  );
}
