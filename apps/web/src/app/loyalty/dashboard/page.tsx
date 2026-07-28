import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { LoyaltyAccountDto, BusinessPublicDto } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { publicApiFetch } from '@/lib/public-api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

/**
 * "My loyalty cards" -- one card per business the customer is enrolled in.
 * Business names aren't on LoyaltyAccountDto (that DTO is business-scoped
 * data, name is a business concern), so this fetches each business's
 * public name alongside the accounts, same shape as dashboard/feedback's
 * Promise.all pattern.
 */
export default async function LoyaltyCustomerDashboardPage() {
  const accounts = await customerApiFetch<LoyaltyAccountDto[]>('/loyalty/me/accounts');

  const businesses = await Promise.all(
    accounts.map((account) =>
      publicApiFetch<BusinessPublicDto>(`/businesses/${account.businessId}/public`),
    ),
  );
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));
  // i18n & Multi-Currency Block 6.
  const t = await getTranslations('loyalty.customer.myRewards');

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>

      {accounts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {accounts.map((account) => (
            <Link key={account.id} href={`/loyalty/dashboard/${account.businessId}`}>
              <Card className="transition-colors hover:border-brand-300">
                <CardContent className="flex items-center justify-between py-4">
                  <div>
                    <p className="font-medium text-neutral-900">
                      {businessNames.get(account.businessId) ?? t('businessFallback')}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {t('visits', { count: account.visitCount })}
                    </p>
                  </div>
                  <p className="text-xl font-semibold text-brand-700">{account.points} pts</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
