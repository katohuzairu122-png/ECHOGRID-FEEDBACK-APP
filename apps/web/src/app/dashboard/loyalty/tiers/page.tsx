import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { LoyaltyTierDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { LoyaltySubnav } from '../loyalty-subnav';
import { TierFormDialog } from './tier-form-dialog';
import { DeleteTierButton } from './delete-tier-button';

export default async function LoyaltyTiersPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 6.
  const t = await getTranslations('loyalty.staff');

  const tiers = await apiFetch<LoyaltyTierDto[]>('/loyalty/tiers', { businessId: business.id });
  const sorted = [...tiers].sort((a, b) => a.minPoints - b.minPoints);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{business.name}</p>
        </div>
        <TierFormDialog trigger={<Button type="button">{t('tiers.newButton')}</Button>} />
      </div>

      <LoyaltySubnav />

      {sorted.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('tiers.emptyTitle')}</CardTitle>
            <CardDescription>{t('tiers.emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {sorted.map((tier) => (
            <Card key={tier.id}>
              <CardContent className="flex items-center justify-between gap-4 py-4">
                <div>
                  <p className="font-medium text-neutral-900">{tier.name}</p>
                  <p className="text-xs text-neutral-500">
                    {t('tiers.minPoints', { points: tier.minPoints })}
                    {tier.benefits ? ` · ${tier.benefits}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <TierFormDialog
                    tier={tier}
                    trigger={
                      <Button type="button" variant="outline" size="sm">
                        {t('tiers.editButton')}
                      </Button>
                    }
                  />
                  <DeleteTierButton tierId={tier.id} tierName={tier.name} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
