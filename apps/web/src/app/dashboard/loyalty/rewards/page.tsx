import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { LoyaltyRewardDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { LoyaltySubnav } from '../loyalty-subnav';
import { RewardFormDialog } from './reward-form-dialog';
import { RewardRowActions } from './reward-row-actions';

export default async function LoyaltyRewardsPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 6.
  const t = await getTranslations('loyalty.staff');

  // Staff sees the full catalog, active and retired -- the customer-facing
  // catalog (GET /loyalty/me/rewards/:businessId) filters to active-only.
  const rewards = await apiFetch<LoyaltyRewardDto[]>('/loyalty/rewards', { businessId: business.id });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{business.name}</p>
        </div>
        <RewardFormDialog trigger={<Button type="button">{t('rewards.newButton')}</Button>} />
      </div>

      <LoyaltySubnav />

      {rewards.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('rewards.emptyTitle')}</CardTitle>
            <CardDescription>{t('rewards.emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rewards.map((reward) => (
            <Card key={reward.id}>
              <CardContent className="flex items-center justify-between gap-4 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-neutral-900">{reward.name}</p>
                    <Badge variant={reward.status === 'active' ? 'brand' : 'neutral'}>
                      {reward.status === 'active' ? t('rewards.active') : t('rewards.inactive')}
                    </Badge>
                  </div>
                  <p className="text-xs text-neutral-500">
                    {t('rewards.pointsCost', { points: reward.pointsCost })}
                    {reward.description ? ` · ${reward.description}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <RewardFormDialog
                    reward={reward}
                    trigger={
                      <Button type="button" variant="outline" size="sm">
                        {t('rewards.editButton')}
                      </Button>
                    }
                  />
                  <RewardRowActions rewardId={reward.id} status={reward.status} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
