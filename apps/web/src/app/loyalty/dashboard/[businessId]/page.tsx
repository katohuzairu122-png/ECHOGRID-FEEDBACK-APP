import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type {
  LoyaltyAccountDto,
  LoyaltyTransactionDto,
  LoyaltyRewardDto,
  LoyaltyTierDto,
  BusinessPublicDto,
} from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import { Badge, Card, CardContent, CardHeader, CardTitle, Progress } from '@/components/ui';
import { RewardCard } from './reward-card';

interface LoyaltyAccountSummary {
  account: LoyaltyAccountDto;
  recentTransactions: LoyaltyTransactionDto[];
}

interface LoyaltyBusinessPageProps {
  params: Promise<{ businessId: string }>;
}

export default async function LoyaltyBusinessPage({ params }: LoyaltyBusinessPageProps) {
  const { businessId } = await params;

  let summary: LoyaltyAccountSummary;
  try {
    summary = await customerApiFetch<LoyaltyAccountSummary>(`/loyalty/me/accounts/${businessId}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const [business, rewards, tiers] = await Promise.all([
    publicApiFetch<BusinessPublicDto>(`/businesses/${businessId}/public`),
    customerApiFetch<LoyaltyRewardDto[]>(`/loyalty/me/rewards/${businessId}`),
    customerApiFetch<LoyaltyTierDto[]>(`/loyalty/me/tiers/${businessId}`),
  ]);

  // i18n & Multi-Currency Block 3 -- reads from the [businessId] layout's
  // own NextIntlClientProvider (Block 2), i.e. THIS business's locale, not
  // the staff-resolved request default.
  const format = await getFormatter();
  // i18n & Multi-Currency Block 6 -- same provider, so this is also the
  // business's own locale, not the staff-resolved default.
  const t = await getTranslations('loyalty.customer.businessDashboard');

  const { account, recentTransactions } = summary;
  const sortedTiers = [...tiers].sort((a, b) => a.minPoints - b.minPoints);
  const currentTier = sortedTiers.filter((tier) => tier.minPoints <= account.points).at(-1);
  const nextTier = sortedTiers.find((tier) => tier.minPoints > account.points);
  const progress = nextTier
    ? ((account.points - (currentTier?.minPoints ?? 0)) /
        (nextTier.minPoints - (currentTier?.minPoints ?? 0))) *
      100
    : 100;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Link
          href={`/loyalty/dashboard/${businessId}/notifications`}
          className="text-sm font-medium text-brand-600 hover:underline"
        >
          {t('notificationPreferences')}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{business.name}</CardTitle>
            {currentTier && <Badge variant="brand">{currentTier.name}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-4xl font-semibold text-brand-600">{t('points', { points: account.points })}</p>
          {sortedTiers.length > 0 && (
            <Progress
              value={progress}
              label={
                nextTier
                  ? t('progressToNextTier', {
                      remaining: nextTier.minPoints - account.points,
                      tierName: nextTier.name,
                    })
                  : t('topTierReached')
              }
            />
          )}
        </CardContent>
      </Card>

      {rewards.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-neutral-900">{t('rewardsHeading')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rewards.map((reward) => (
              <RewardCard key={reward.id} reward={reward} businessId={businessId} currentPoints={account.points} />
            ))}
          </div>
        </div>
      )}

      {recentTransactions.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-neutral-900">{t('recentActivityHeading')}</h2>
          <Card>
            <CardContent className="flex flex-col divide-y divide-neutral-100 py-0">
              {recentTransactions.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium capitalize text-neutral-900">
                      {tx.type.replace('_', ' ')}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {format.dateTime(new Date(tx.createdAt), 'short')}
                    </p>
                  </div>
                  <p className={tx.points >= 0 ? 'text-sm font-medium text-success' : 'text-sm font-medium text-danger'}>
                    {t('points', { points: `${tx.points >= 0 ? '+' : ''}${tx.points}` })}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
