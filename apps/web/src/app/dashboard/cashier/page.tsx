import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { getMyAccess } from '@/lib/permissions';
import { cashierAppUrl } from '@/lib/cashier/host';
import { RestrictedPanel } from '@/components/workspace/restricted-panel';
import { buttonVariants } from '@/components/ui';
import { cn } from '@/lib/utils';
import { CashierSessionsPanel, type CashierSessionView } from './cashier-sessions-panel';

/**
 * CASHIER-PWA-01 C5/C6: the dashboard's entry to the cashier app. Anyone who holds `loyalty:serve` (the default Owner,
 * Manager and Staff roles) sees it, so owners need no extra setup or approval; those who also hold
 * `business:manage_settings` (Owner and Admin) additionally manage the business's active cashier sessions. Presentation
 * only: the cashier sign-in and the session routes enforce the same permissions on the API.
 */
export default async function CashierAppPage() {
  const t = await getTranslations('cashier.dashboard');
  const access = await getMyAccess();
  if (!access.known) return <RestrictedPanel variant="unavailable" />;
  const canServe = access.permissions.has('loyalty:serve');
  const canManage = access.permissions.has('business:manage_settings');
  const url = cashierAppUrl();

  let sessions: CashierSessionView[] | null = null;
  if (canManage) {
    const business = await getActiveBusiness();
    if (business) {
      sessions = await apiFetch<CashierSessionView[]>('/cashier-sessions', {
        businessId: business.id,
        cache: 'no-store',
      }).catch(() => null);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('subtitle')}</p>
      </header>

      {!canServe ? (
        <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm">{t('noAccess')}</p>
      ) : (
        <>
          <div className="space-y-3">
            <p className="text-sm">{t('access')}</p>
            {canManage && <p className="text-sm text-neutral-600">{t('ownerNote')}</p>}
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ size: 'lg' }), 'min-h-12')}>
                {t('open')}
              </a>
            ) : (
              <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-700">{t('unavailable')}</p>
            )}
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold">{t('installTitle')}</h2>
            <p className="text-sm text-neutral-600">{t('installIntro')}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>{t('steps.android')}</li>
              <li>{t('steps.ios')}</li>
              <li>{t('steps.desktop')}</li>
            </ul>
            <p className="text-sm text-neutral-600">{t('unsupportedNote')}</p>
          </div>
        </>
      )}

      {(canManage || access.permissions.has('audit:view') || access.permissions.has('loyalty:accounts:view')) && (
        <Link href="/dashboard/cashier/activity" className="inline-block text-sm underline">
          {t('activity.open')}
        </Link>
      )}

      {canManage && sessions && <CashierSessionsPanel sessions={sessions} />}
      {canManage && !sessions && (
        <p className="text-sm text-red-700">{t('sessions.loadFailed')}</p>
      )}
    </section>
  );
}
