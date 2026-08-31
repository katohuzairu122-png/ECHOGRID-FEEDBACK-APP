import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { LoyaltyRewardDto, BranchDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Badge, Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
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
  //
  // Continuing Development Block 6.8.1 (S6.1 campaign config UI) -- branches
  // fetched alongside rewards so RewardFormDialog's new branch-scope
  // <select> has real names to list, mirroring dashboard/feedback/page.tsx's
  // BranchFilter precedent exactly (server-fetch, pass down as a prop, no
  // client-side self-fetch). Safe for every role that can reach this page:
  // rewards:manage implies branches:view for all three default roles that
  // hold it (Owner/Admin/Manager -- confirmed against
  // role-provisioning.service.ts before choosing this over 6.7.3's more
  // defensive server-side-resolution pattern).
  const [rewards, branches] = await Promise.all([
    apiFetch<LoyaltyRewardDto[]>('/loyalty/rewards', { businessId: business.id }),
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{business.name}</p>
        </div>
        <RewardFormDialog branches={branches} trigger={<Button type="button">{t('rewards.newButton')}</Button>} />
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
                    {/* CI fix (Block 6.6): pointsCost is nullable now (non-points
                        reward types) -- same reasoning as reward-card.tsx. */}
                    {reward.pointsCost !== null && t('rewards.pointsCost', { points: reward.pointsCost })}
                    {reward.description ? ` · ${reward.description}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/* Continuing Development Block 6.7.3 (S6.3 campaign
                      dashboard) -- plain <Link> styled via buttonVariants,
                      not <Button> wrapped in <Link>: nesting a real
                      <button> inside an <a> breaks accessible-name
                      computation (see buttonVariants' own export comment). */}
                  <Link
                    href={`/dashboard/loyalty/rewards/${reward.id}`}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('campaignDashboard.viewButton')}
                  </Link>
                  <RewardFormDialog
                    reward={reward}
                    branches={branches}
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
