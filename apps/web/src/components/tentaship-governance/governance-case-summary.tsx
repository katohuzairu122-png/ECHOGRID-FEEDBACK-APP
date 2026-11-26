'use client';

import { useTranslations } from 'next-intl';
import type { GovernanceCaseResult } from '@/lib/tentaship-governance-types';

/**
 * G3 (contained, NOT routed): a governance case's RECORDED summary. Presentation only: it cannot decide, override or change a case; there is no identity, no evidence text and no customer
 * data. A failed evidence-log verification is announced as an alert, never hidden.
 */
export function GovernanceCaseSummary({ result }: { result: GovernanceCaseResult }) {
  const t = useTranslations('common.tentashipGovernance');
  if (result.state === 'unavailable') {
    return (
      <section aria-labelledby="tgc-title" className="rounded-md border border-neutral-200 bg-white p-4 text-start" data-testid="governance-case">
        <h2 id="tgc-title" className="text-lg font-semibold">{t('title')}</h2>
        <p role="status" className="text-sm text-neutral-600">{t('unavailable')}</p>
      </section>
    );
  }
  const c = result.case;
  const row = (id: string, label: string, value: string, alert = false) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-neutral-100 py-1 text-sm">
      <dt className="text-neutral-600">{label}</dt>
      <dd className="font-medium" data-testid={id} {...(alert ? { role: 'alert' } : {})}>{value}</dd>
    </div>
  );
  return (
    <section aria-labelledby="tgc-title" className="space-y-3 rounded-md border border-neutral-200 bg-white p-4 text-start" data-testid="governance-case">
      <h2 id="tgc-title" className="text-lg font-semibold">{t('title')}</h2>
      <dl>
        {row('case-kind', t('kindLabel'), t(`kind.${c.kind}`))}
        {row('case-status', t('statusLabel'), t(`status.${c.status}`))}
        {row('case-decision', t('decisionLabel'), c.decision ? t(`decision.${c.decision}`) : t('decisionNone'))}
        {row('case-evidence', t('evidenceLabel'), String(c.evidenceCount))}
        {row('case-policy', t('policyLabel'), c.policyVersion === null ? t('policyNone') : t('policyVersion', { version: c.policyVersion }))}
        {row('case-chain', t('chainLabel'), t(`chain.${c.chain}`), c.chain === 'broken')}
      </dl>
      <p className="text-xs text-neutral-500">{t('note')}</p>
    </section>
  );
}
