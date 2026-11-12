import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { LoyaltyRewardDto, BranchDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { canConfigureProgramme, getMyAccess } from '@/lib/permissions';
import { apiFetch } from '@/lib/api-client';
import { Badge, Button, buttonVariants } from '@/components/ui';
import { LoyaltySubnav } from '../loyalty-subnav';
import { LoyaltyCatalogCard } from '../loyalty-catalog-card';
import styles from '../loyalty-catalog.module.css';
import { RewardFormDialog } from './reward-form-dialog';
import { RewardRowActions } from './reward-row-actions';

export default async function LoyaltyRewardsPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  // Programme configuration is for the business owner and admins, not counter staff.
  if (!canConfigureProgramme(await getMyAccess())) redirect('/dashboard/loyalty');

  const t = await getTranslations('loyalty.staff');

  // Staff sees the full catalog, including paused/retired rewards. The
  // customer-facing list is separately authorized and filters to active.
  // Preserve both existing tenant-scoped reads: dialog branch options are
  // resolved server-side, never invented on the client.
  const [rewards, branches] = await Promise.all([
    apiFetch<LoyaltyRewardDto[]>('/loyalty/rewards', { businessId: business.id }),
    apiFetch<BranchDto[]>('/branches', { businessId: business.id }),
  ]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{business.name}</p>
          <h1 className="text-2xl font-semibold">{t('subnav.rewards')}</h1>
        </div>
        <div className={styles.headerActions}>
          <RewardFormDialog
            branches={branches}
            trigger={<Button type="button">{t('rewards.newButton')}</Button>}
          />
        </div>
      </header>

      <LoyaltySubnav />

      {rewards.length === 0 ? (
        <section className={styles.empty}>
          <h2>{t('rewards.emptyTitle')}</h2>
          <p>{t('rewards.emptyDescription')}</p>
        </section>
      ) : (
        <section aria-label={t('subnav.rewards')}>
          <ul className={styles.list}>
            {rewards.map((reward) => (
              <li key={reward.id}>
                <LoyaltyCatalogCard
                  kind="reward"
                  title={reward.name}
                  status={
                    <Badge
                      variant={
                        reward.status === 'active'
                          ? 'brand'
                          : reward.status === 'paused'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {reward.status === 'active'
                        ? t('rewards.active')
                        : reward.status === 'paused'
                          ? t('rewards.paused')
                          : t('rewards.inactive')}
                    </Badge>
                  }
                  details={
                    <>
                      {reward.pointsCost !== null && (
                        <span>{t('rewards.pointsCost', { points: reward.pointsCost })}</span>
                      )}
                      {reward.description && <span>{reward.description}</span>}
                    </>
                  }
                  actions={
                    <>
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
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
