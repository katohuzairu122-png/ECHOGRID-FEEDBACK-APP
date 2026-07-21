'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { generateSummaryAction } from '@/lib/actions/analytics';
import { Button } from '@/components/ui';

interface SummaryGeneratorProps {
  /** Reuses the page's own branch filter rather than a second selector --
   * generation and the summaries list should always agree on scope
   * (business-wide vs. one branch are different report types, see
   * feedback-summary.repository.ts, never mixed in one view). */
  branchId?: string | undefined;
}

/**
 * No confirm() dialog, unlike QrCodeDialog's regenerate -- this doesn't
 * destroy anything, it only queues a new job. The API's own
 * analytics:manage permission gate (not analytics:view) is what actually
 * protects the real cost here (a paid Anthropic call per invocation); a
 * confirm() on top of that would just add friction to a legitimate,
 * non-destructive action.
 */
export function SummaryGenerator({ branchId }: SummaryGeneratorProps) {
  const [periodType, setPeriodType] = useState<'weekly' | 'monthly'>('weekly');
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // i18n & Multi-Currency Block 7.
  const t = useTranslations('analytics.summaryGenerator');

  const handleGenerate = () => {
    setQueued(false);
    setError(null);
    startTransition(async () => {
      try {
        await generateSummaryAction({ periodType, branchId });
        setQueued(true);
      } catch {
        setError(t('error'));
      }
    });
  };

  return (
    <div className="flex flex-col gap-2 border-b border-neutral-200 pb-4 sm:flex-row sm:items-center sm:gap-3">
      <select
        value={periodType}
        onChange={(e) => setPeriodType(e.target.value as 'weekly' | 'monthly')}
        aria-label={t('periodAriaLabel')}
        className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <option value="weekly">{t('weekly')}</option>
        <option value="monthly">{t('monthly')}</option>
      </select>
      <Button type="button" size="sm" onClick={handleGenerate} disabled={pending}>
        {pending ? t('queuing') : t('generate')}
      </Button>
      {queued && <p className="text-xs text-neutral-500">{t('queued')}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
