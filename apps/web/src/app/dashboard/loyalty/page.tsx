import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import type { LoyaltyAccountWithCustomerDto } from '@/lib/actions/loyalty';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { LoyaltySubnav } from './loyalty-subnav';
import { AccountDialog } from './account-dialog';

/** Staff landing page for Loyalty -- the accounts list, same PAGE_SIZE+1
 * "has more" trick dashboard/feedback/page.tsx uses (no total-count query
 * on the backend to build real page-N-of-M pagination from). */
const PAGE_SIZE = 20;

export default async function LoyaltyDashboardPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 3 -- see dashboard/feedback/page.tsx's
  // identical comment.
  const format = await getFormatter();
  // i18n & Multi-Currency Block 6.
  const t = await getTranslations('loyalty.staff');

  const accounts = await apiFetch<LoyaltyAccountWithCustomerDto[]>(
    `/loyalty/accounts?limit=${PAGE_SIZE}`,
    { businessId: business.id },
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      <LoyaltySubnav />

      {accounts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('accounts.emptyTitle')}</CardTitle>
            <CardDescription>{t('accounts.emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardContent className="flex items-center justify-between gap-4 py-4">
                <div>
                  <p className="font-medium text-neutral-900">
                    {account.customer.fullName ?? account.customer.phone}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {t('accounts.visits', { count: account.visitCount })} ·{' '}
                    {account.lastVisitAt
                      ? t('accounts.lastVisit', {
                          date: format.dateTime(new Date(account.lastVisitAt), 'short'),
                        })
                      : t('accounts.noVisits')}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {account.status !== 'active' && (
                    <Badge variant="neutral">{t('accounts.suspended')}</Badge>
                  )}
                  <p className="text-lg font-semibold text-brand-700">{account.points} pts</p>
                  <AccountDialog
                    accountId={account.id}
                    customerLabel={account.customer.fullName ?? account.customer.phone}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
