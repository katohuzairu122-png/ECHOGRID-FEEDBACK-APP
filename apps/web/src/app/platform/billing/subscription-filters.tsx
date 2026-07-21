'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Select } from '@/components/ui';

interface SubscriptionFiltersProps {
  status?: string | undefined;
}

/** Single-field filter -- simpler than businesses/business-filters.tsx's
 * combined search+status bar since there's no free-text search dimension
 * here, only status. Same URL-is-the-source-of-truth, offset-dropped-on-
 * every-new-filter reasoning as every other filter form in this console. */
export function SubscriptionFilters({ status }: SubscriptionFiltersProps) {
  const router = useRouter();
  const [statusInput, setStatusInput] = useState(status ?? '');
  const t = useTranslations('platform.billing.subscriptions.filters');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (statusInput) params.set('status', statusInput);
    router.push(`/platform/billing?${params}`);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-600">{t('statusLabel')}</span>
        <Select value={statusInput} onChange={(e) => setStatusInput(e.target.value)} className="w-48">
          <option value="">{t('anyStatus')}</option>
          <option value="trialing">{t('statusTrialing')}</option>
          <option value="active">{t('statusActive')}</option>
          <option value="past_due">{t('statusPastDue')}</option>
          <option value="incomplete">{t('statusIncomplete')}</option>
          <option value="canceled">{t('statusCanceled')}</option>
          <option value="incomplete_expired">{t('statusIncompleteExpired')}</option>
          <option value="unpaid">{t('statusUnpaid')}</option>
        </Select>
      </label>
      <Button type="submit" size="sm">
        {t('apply')}
      </Button>
    </form>
  );
}
