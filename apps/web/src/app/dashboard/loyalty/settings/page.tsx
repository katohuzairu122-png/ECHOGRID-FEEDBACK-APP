import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { LoyaltySettingsDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { LoyaltySubnav } from '../loyalty-subnav';
import { SettingsForm } from './settings-form';

export default async function LoyaltySettingsPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  const settings = await apiFetch<LoyaltySettingsDto>('/loyalty/settings', { businessId: business.id });
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
          <CardTitle>{t('settings.sectionTitle')}</CardTitle>
          <CardDescription>{t('settings.sectionDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm settings={settings} currency={business.defaultCurrency} />
        </CardContent>
      </Card>
    </div>
  );
}
