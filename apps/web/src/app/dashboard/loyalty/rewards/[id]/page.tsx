import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { CampaignDashboardDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch, ApiError } from '@/lib/api-client';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@/components/ui';
import { RewardCard } from '@/app/loyalty/dashboard/[businessId]/reward-card';
import { LoyaltySubnav } from '../../loyalty-subnav';

interface CampaignDashboardPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Continuing Development Block 6.7.3 (S6.3 campaign dashboard). Staff-only
 * detail view for one reward/campaign, reached from the rewards list.
 * GET /loyalty/rewards/:id/dashboard (Block 6.7.2) supplies everything
 * rendered here in one call -- no client-side aggregation, no second
 * fetch for branch name (see CampaignDashboard's own comment in
 * loyalty-reward.service.ts for why that was resolved server-side).
 *
 * Deliberately does NOT render reserved/pending/expired/reversed counts,
 * a fraud rate, a per-branch redemption breakdown, or a staff-editable
 * terms field -- none of the underlying data exists yet for any reward
 * (see this block's own Feature Overview / completion notes for the full
 * reasoning on each). Showing only Outstanding/Redeemed, a generated
 * terms summary, and the campaign's own configured branch scope is the
 * honest version of S6.3's fuller ask against what the platform can
 * actually back today.
 */
export default async function CampaignDashboardPage({ params }: CampaignDashboardPageProps) {
  const { id } = await params;
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  const t = await getTranslations('loyalty.staff');
  const format = await getFormatter();

  let dashboard: CampaignDashboardDto;
  try {
    dashboard = await apiFetch<CampaignDashboardDto>(`/loyalty/rewards/${id}/dashboard`, {
      businessId: business.id,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const { reward, branchName, stats } = dashboard;

  const money = (amount: number) =>
    format.number(amount, { style: 'currency', currency: business.defaultCurrency });

  const statusLabel =
    reward.status === 'active'
      ? t('rewards.active')
      : reward.status === 'paused'
        ? t('rewards.paused')
        : t('rewards.inactive');
  const statusVariant = reward.status === 'active' ? 'brand' : reward.status === 'paused' ? 'warning' : 'neutral';

  const budgetPercent =
    stats.budgetTotal !== null && stats.budgetUsed !== null && stats.budgetTotal > 0
      ? (stats.budgetUsed / stats.budgetTotal) * 100
      : null;

  // Plain-language terms assembled from the structured campaign fields
  // already on the reward row -- see this file's own top comment on why
  // there's no staff-authored free-text field to read instead. Branch
  // scope is deliberately not repeated here; the Scope card below already
  // states it once.
  const dateStr = (d: string) => format.dateTime(new Date(d), 'short');
  const terms: string[] = [];
  if (reward.startDate && reward.expiryDate) {
    terms.push(
      t('campaignDashboard.termValidWindow', { start: dateStr(reward.startDate), end: dateStr(reward.expiryDate) }),
    );
  } else if (reward.startDate) {
    terms.push(t('campaignDashboard.termValidFrom', { start: dateStr(reward.startDate) }));
  } else if (reward.expiryDate) {
    terms.push(t('campaignDashboard.termValidUntil', { end: dateStr(reward.expiryDate) }));
  }
  if (reward.limitPer === 'receipt') terms.push(t('campaignDashboard.termLimitPerReceipt'));
  if (reward.limitPer === 'visit') terms.push(t('campaignDashboard.termLimitPerVisit'));
  if (reward.limitPer === 'period' && reward.limitPeriodDays !== null) {
    terms.push(t('campaignDashboard.termLimitPerPeriod', { days: reward.limitPeriodDays }));
  }
  if (reward.cooldownSeconds !== null) {
    terms.push(t('campaignDashboard.termCooldown', { seconds: reward.cooldownSeconds }));
  }
  if (reward.maxRewardsPerDay !== null) {
    terms.push(t('campaignDashboard.termMaxPerDay', { count: reward.maxRewardsPerDay }));
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard/loyalty/rewards" className="text-sm text-neutral-500 hover:text-brand-700">
          {t('campaignDashboard.backLink')}
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-neutral-900">{reward.name}</h1>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      <LoyaltySubnav />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('campaignDashboard.budgetHeading')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {stats.budgetUsed === null ? (
              <CardDescription>{t('campaignDashboard.budgetNotApplicable')}</CardDescription>
            ) : budgetPercent !== null && stats.budgetTotal !== null ? (
              <Progress
                value={budgetPercent}
                label={t('campaignDashboard.budgetUsedOf', {
                  used: money(stats.budgetUsed),
                  total: money(stats.budgetTotal),
                })}
              />
            ) : (
              <p className="text-sm text-neutral-700">
                {t('campaignDashboard.budgetUsedNoCap', { used: money(stats.budgetUsed) })}
              </p>
            )}
            {stats.outstandingLiability !== null && (
              <p className="text-xs text-neutral-500">
                {t('campaignDashboard.outstandingLiabilityLabel')}: {money(stats.outstandingLiability)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('campaignDashboard.activityHeading')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-neutral-600">{t('campaignDashboard.outstanding')}</span>
              <span className="text-lg font-semibold text-neutral-900">{stats.outstandingCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-neutral-600">{t('campaignDashboard.redeemed')}</span>
              <span className="text-lg font-semibold text-neutral-900">{stats.redeemedCount}</span>
            </div>
            <div className="flex items-center justify-between border-t border-neutral-100 pt-3">
              <span className="text-sm text-neutral-600">{t('campaignDashboard.redemptionRateLabel')}</span>
              <span className="text-sm font-medium text-neutral-900">
                {stats.redemptionRate !== null
                  ? format.number(stats.redemptionRate, { style: 'percent', maximumFractionDigits: 0 })
                  : t('campaignDashboard.redemptionRateNoData')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('campaignDashboard.scopeHeading')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-neutral-700">
              {branchName
                ? t('campaignDashboard.scopeOneBranch', { branchName })
                : t('campaignDashboard.scopeAllBranches')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('campaignDashboard.termsHeading')}</CardTitle>
          </CardHeader>
          <CardContent>
            {terms.length === 0 ? (
              <p className="text-sm text-neutral-700">{t('campaignDashboard.termsNone')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm text-neutral-700">
                {terms.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="max-w-sm">
        <h2 className="mb-2 text-sm font-medium text-neutral-700">{t('campaignDashboard.previewHeading')}</h2>
        <RewardCard reward={reward} businessId={business.id} readOnly />
      </div>
    </div>
  );
}
