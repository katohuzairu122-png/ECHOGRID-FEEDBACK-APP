import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import type { WalletEntry } from '@/lib/loyalty-wallet';

/**
 * The customer's loyalty wallet: one account, one card per business. Each business keeps its own membership,
 * points and rewards, so nothing here adds points across businesses.
 */
export function LoyaltyWalletView({ entries }: { entries: readonly WalletEntry[] }) {
  const t = useTranslations('loyalty.customer.wallet');
  const format = useFormatter();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('intro')}</p>
      </header>

      <nav aria-label={t('actionsLabel')} className="flex flex-wrap gap-4">
        <Link href="/loyalty/dashboard/qr" className="text-brand-700 underline">
          {t('showQr')}
        </Link>
        <Link href="/loyalty/dashboard/settlements" className="text-brand-700 underline">
          {t('settlements')}
        </Link>
      </nav>

      {entries.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <section aria-labelledby="wallet-count" className="flex flex-col gap-3">
          <h2 id="wallet-count" className="text-sm font-medium text-neutral-600">
            {t('count', { count: entries.length })}
          </h2>
          <ul className="flex flex-col gap-3">
            {entries.map(({ account, businessName }) => {
              const name = businessName ?? t('businessFallback');
              const paused = account.status !== 'active';
              return (
                <li key={account.id}>
                  <Link
                    href={`/loyalty/dashboard/${account.businessId}`}
                    aria-label={t('openBusiness', { name })}
                    className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                  >
                    <Card className="transition-colors hover:border-brand-300">
                      <CardContent className="flex items-center justify-between gap-4 py-4">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 font-medium text-neutral-900">
                            <span className="truncate">{name}</span>
                            {paused && <Badge variant="accent">{t('paused')}</Badge>}
                          </p>
                          <p className="text-xs text-neutral-500">
                            {t('visits', { count: account.visitCount })}
                            {' · '}
                            {account.lastVisitAt
                              ? t('lastVisit', {
                                  date: format.dateTime(new Date(account.lastVisitAt), 'short'),
                                })
                              : t('noVisitsYet')}
                          </p>
                          <p className="mt-1 text-xs text-brand-700">{t('viewDetails')}</p>
                        </div>
                        <p className="shrink-0 text-xl font-semibold text-brand-700">
                          {t('points', { points: account.points })}
                        </p>
                      </CardContent>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-neutral-500">{t('separateNote')}</p>
        </section>
      )}
    </div>
  );
}

/** Shown when the accounts read is rate limited or the service is down. Never an empty wallet. */
export function LoyaltyWalletUnavailable() {
  const t = useTranslations('loyalty.customer.wallet');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
      <div role="status" className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
        <p className="font-medium text-neutral-900">{t('unavailableTitle')}</p>
        <p className="text-sm text-neutral-600">{t('unavailableBody')}</p>
        <Link href="/loyalty/dashboard" className="text-brand-700 underline">
          {t('retry')}
        </Link>
      </div>
    </div>
  );
}
