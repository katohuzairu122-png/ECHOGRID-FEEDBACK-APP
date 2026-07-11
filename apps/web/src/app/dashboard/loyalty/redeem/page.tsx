import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { LoyaltySubnav } from '../loyalty-subnav';
import { RedeemLookupForm } from './redeem-lookup-form';

export default async function LoyaltyRedeemPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 6.
  const t = await getTranslations('loyalty.staff');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      <LoyaltySubnav />

      <Card>
        <CardHeader>
          <CardTitle>{t('redeem.title')}</CardTitle>
          <CardDescription>{t('redeem.description')}</CardDescription>
        </CardHeader>
      </Card>

      <RedeemLookupForm />
    </div>
  );
}
