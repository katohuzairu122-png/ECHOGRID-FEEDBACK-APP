'use client';

import { useLocale, useTranslations } from 'next-intl';
import { disclosureText, type CampaignResult } from '@/lib/tentaship-campaign-types';

/**
 * TSH-06 (customer foundation, NOT routed and NOT reachable): shows a campaign's RECORDED information. Presentation only: there is no button that joins, accepts,
 * enters, draws or claims anything, no odds, prize or value, and no "guaranteed" wording. The disclosure text is the recorded text verbatim (the UI never
 * rewrites legal or outcome wording); the layout uses logical (start/end) classes so Arabic RTL mirrors correctly. Wire-up needs the Owner's legal approvals.
 */
export function CampaignStatusCard({ result }: { result: CampaignResult }) {
  const t = useTranslations('common.tentashipCampaign');
  const locale = useLocale();
  if (result.state === 'unavailable') {
    return (
      <section aria-labelledby="tentaship-campaign-title" className="rounded-md border border-neutral-200 bg-white p-4 text-start" data-testid="tentaship-campaign">
        <h2 id="tentaship-campaign-title" className="text-lg font-semibold">{t('title')}</h2>
        <p role="status" className="text-sm text-neutral-600">{t('unavailable')}</p>
      </section>
    );
  }
  const c = result.campaign;
  return (
    <section aria-labelledby="tentaship-campaign-title" className="space-y-3 rounded-md border border-neutral-200 bg-white p-4 text-start" data-testid="tentaship-campaign">
      <h2 id="tentaship-campaign-title" className="text-lg font-semibold">{t('title')}</h2>
      <p className="text-sm"><span className="font-medium">{t('statusLabel')}: </span><span data-testid="campaign-status">{t(`status.${c.status}`)}</span></p>
      <div className="space-y-1">
        <h3 className="font-medium">{t('eligibility.title')}</h3>
        <p className="text-sm" data-testid="campaign-eligibility">{t(`eligibility.${c.eligibility}`)}</p>
        <p className="text-xs text-neutral-500">{t('eligibility.note')}</p>
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">{t('disclosureTitle')}</h3>
        <p className="whitespace-pre-line text-sm" data-testid="campaign-disclosure">{disclosureText(c.disclosure, locale)}</p>
        <p className="text-xs text-neutral-500">{t('termsVersion', { version: c.termsVersion })}</p>
        <p className="break-all text-xs text-neutral-500" dir="ltr">{t('disclosureRef', { hash: c.disclosureHash.slice(0, 12) })}</p>
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">{t('participation.title')}</h3>
        <p className="text-sm" data-testid="campaign-participation">{t(`participation.${c.participation}`)}</p>
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">{t('allocation.title')}</h3>
        <p className="text-sm">{c.outcomeRecorded ? t('allocation.title') : t('allocation.notRecorded')}</p>
      </div>
      <p className="text-xs text-neutral-500">{t('outcomeNotice')}</p>
    </section>
  );
}
