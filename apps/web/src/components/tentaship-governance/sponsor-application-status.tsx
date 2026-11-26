'use client';

import { useTranslations } from 'next-intl';
import type { SponsorApplicationResult } from '@/lib/tentaship-governance-types';

/** G3 (contained, NOT routed): a sponsor's RECORDED application status. Presentation only: no button submits, approves or changes anything; the reason is the recorded text verbatim. */
export function SponsorApplicationStatus({ result }: { result: SponsorApplicationResult }) {
  const t = useTranslations('common.tentashipSponsorApplication');
  if (result.state === 'unavailable') {
    return (
      <section aria-labelledby="tsa-title" className="rounded-md border border-neutral-200 bg-white p-4 text-start" data-testid="sponsor-application">
        <h2 id="tsa-title" className="text-lg font-semibold">{t('title')}</h2>
        <p role="status" className="text-sm text-neutral-600">{t('unavailable')}</p>
      </section>
    );
  }
  const a = result.application;
  return (
    <section aria-labelledby="tsa-title" className="space-y-3 rounded-md border border-neutral-200 bg-white p-4 text-start" data-testid="sponsor-application">
      <h2 id="tsa-title" className="text-lg font-semibold">{t('title')}</h2>
      <p className="text-sm"><span className="font-medium">{t('statusLabel')}: </span><span data-testid="sponsor-status">{t(`status.${a.status}`)}</span></p>
      {a.reason ? <p className="text-sm"><span className="font-medium">{t('reasonLabel')}: </span><span data-testid="sponsor-reason">{a.reason}</span></p> : null}
      <p className="text-xs text-neutral-500">{t('changedLabel')}: <span dir="ltr" data-testid="sponsor-changed">{a.changedAt.slice(0, 10)}</span></p>
      <p className="text-xs text-neutral-500">{t('note')}</p>
    </section>
  );
}
