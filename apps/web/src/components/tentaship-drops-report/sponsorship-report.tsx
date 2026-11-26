'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { reasonKey, type ReportMetric, type SponsorshipReportResult } from '@/lib/tentaship-drops-report-types';

/**
 * TDP-04 sponsor reporting foundation (CONTAINED: no route renders it for a business account; sponsor access needs the Owner's permission model). Presentation of
 * recorded AGGREGATES only: overview, inventory now, reservation history, allocation/collection, reconciliation and honest unavailable states. There is no action, link
 * or export, no customer identity, and no revenue, return or acquisition figure. A figure the evidence cannot support is shown as "not available" with its reason, never as 0.
 * Logical (start/end) classes keep Arabic RTL correct.
 */
export function SponsorshipReport({ result }: { result: SponsorshipReportResult }) {
  const t = useTranslations('common.tentashipDropsReport');
  const f = useFormatter();
  const shell = (children: React.ReactNode) => (
    <section aria-labelledby="drops-report-title" className="space-y-4 rounded-md border border-neutral-200 bg-white p-4 text-start" data-testid="drops-report">
      <h2 id="drops-report-title" className="text-lg font-semibold">{t('title')}</h2>
      {children}
    </section>
  );
  if (result.state === 'unavailable') return shell(<p role="status" className="text-sm text-neutral-600">{t('unavailable')}</p>);
  const overview = (
    <div className="space-y-1" data-testid="drops-overview">
      <h3 className="font-medium">{t('overview.title')}</h3>
      <p className="text-sm"><span className="font-medium">{t('overview.statusLabel')}: </span><span data-testid="drops-status">{t(`overview.status.${result.status}`)}</span></p>
    </div>
  );
  if (result.state === 'no_inventory') return shell(<>{overview}<p className="text-sm text-neutral-600" role="status">{t('noInventory')}</p></>);
  const m = result.metrics;
  const val = (v: ReportMetric, testId: string, pct = false) => typeof v === 'number'
    ? <dd className="text-sm font-medium tabular-nums" data-testid={testId}>{pct ? f.number(v, { style: 'percent', maximumFractionDigits: 0 }) : f.number(v)}</dd>
    : <dd className="text-sm text-neutral-600" data-testid={testId} data-unavailable="true">{t('unavailableMetric')} <span className="text-xs text-neutral-500">({t(`reason.${reasonKey(v.reason)}`)})</span></dd>;
  const row = (label: string, v: ReportMetric, id: string, pct = false) => (<div className="flex items-baseline justify-between gap-3"><dt className="text-sm">{label}</dt>{val(v, id, pct)}</div>);
  return shell(
    <>
      {overview}
      <div className="space-y-1" data-testid="drops-inventory">
        <h3 className="font-medium">{t('inventory.title')}</h3>
        <dl className="space-y-1">
          {row(t('inventory.total'), m.total, 'm-total')}{row(t('inventory.available'), m.available, 'm-available')}{row(t('inventory.reserved'), m.reserved, 'm-reserved')}
          {row(t('inventory.allocated'), m.allocated, 'm-allocated')}{row(t('inventory.collected'), m.collected, 'm-collected')}{row(t('inventory.expiredUnreturned'), m.allocationsExpired, 'm-expired-unreturned')}
        </dl>
        <p className="text-xs text-neutral-500">{t('inventory.note')}</p>
      </div>
      <div className="space-y-1" data-testid="drops-activity">
        <h3 className="font-medium">{t('activity.title')}</h3>
        <dl className="space-y-1">{row(t('activity.created'), m.reservationsCreated, 'm-created')}{row(t('activity.released'), m.holdsReleased, 'm-released')}{row(t('activity.expired'), m.holdsExpired, 'm-holds-expired')}</dl>
        <p className="text-xs text-neutral-500">{t('activity.note')}</p>
      </div>
      <div className="space-y-1" data-testid="drops-collection">
        <h3 className="font-medium">{t('collection.title')}</h3>
        <dl className="space-y-1">{row(t('collection.outstanding'), m.outstandingCollection, 'm-outstanding')}{row(t('collection.completionRate'), m.collectionCompletionRate, 'm-completion', true)}</dl>
      </div>
      <div className="space-y-1" data-testid="drops-reconciliation">
        <h3 className="font-medium">{t('reconciliation.title')}</h3>
        <p className={m.reconciled ? 'text-sm' : 'text-sm font-medium text-red-800'} role={m.reconciled ? undefined : 'alert'} data-testid="m-reconciled">{m.reconciled ? t('reconciliation.ok') : t('reconciliation.review')}</p>
      </div>
      <p className="text-xs text-neutral-500">{t('notice')}</p>
    </>,
  );
}
