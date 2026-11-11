import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { CampaignDashboardDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch, ApiError } from '@/lib/api-client';
import { Badge, Progress } from '@/components/ui';
import { CampaignStat } from './campaign-stat';
import styles from './campaign-detail.module.css';
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
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/dashboard/loyalty/rewards" className={styles.backLink}>
          {t('campaignDashboard.backLink')}
        </Link>
        <p className={styles.eyebrow}>{business.name}</p>
        <div className={styles.titleRow}>
          <h1>{reward.name}</h1>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
      </header>

      <LoyaltySubnav />

      <div className={styles.grid}>
        <section className={styles.panel} data-panel="budget" aria-labelledby="campaign-budget">
          <div className={styles.panelHeader}>
            <h2 id="campaign-budget">{t('campaignDashboard.budgetHeading')}</h2>
          </div>
          <div className={styles.panelBody}>
            {stats.budgetUsed === null ? (
              <p className={styles.muted}>{t('campaignDashboard.budgetNotApplicable')}</p>
            ) : budgetPercent !== null && stats.budgetTotal !== null ? (
              <Progress
                value={budgetPercent}
                label={t('campaignDashboard.budgetUsedOf', {
                  used: money(stats.budgetUsed),
                  total: money(stats.budgetTotal),
                })}
              />
            ) : (
              <p className={styles.muted}>
                {t('campaignDashboard.budgetUsedNoCap', { used: money(stats.budgetUsed) })}
              </p>
            )}
            {stats.outstandingLiability !== null && (
              <p className={styles.secondary}>
                {t('campaignDashboard.outstandingLiabilityLabel')}: {money(stats.outstandingLiability)}
              </p>
            )}
          </div>
        </section>

        <section className={styles.panel} data-panel="activity" aria-labelledby="campaign-activity">
          <div className={styles.panelHeader}>
            <h2 id="campaign-activity">{t('campaignDashboard.activityHeading')}</h2>
          </div>
          <div className={styles.panelBody}>
            <dl className={styles.stats}>
              <CampaignStat
                label={t('campaignDashboard.outstanding')}
                value={format.number(stats.outstandingCount)}
                tone="mint"
              />
              <CampaignStat
                label={t('campaignDashboard.redeemed')}
                value={format.number(stats.redeemedCount)}
                tone="cyan"
              />
              <CampaignStat
                label={t('campaignDashboard.redemptionRateLabel')}
                value={
                  stats.redemptionRate === null
                    ? '—'
                    : format.number(stats.redemptionRate, {
                        style: 'percent',
                        maximumFractionDigits: 0,
                      })
                }
                hint={
                  stats.redemptionRate === null
                    ? t('campaignDashboard.redemptionRateNoData')
                    : undefined
                }
                tone="violet"
              />
            </dl>
          </div>
        </section>

        <section className={styles.panel} data-panel="scope" aria-labelledby="campaign-scope">
          <div className={styles.panelHeader}>
            <h2 id="campaign-scope">{t('campaignDashboard.scopeHeading')}</h2>
          </div>
          <div className={styles.panelBody}>
            <p className={styles.scopeValue}>
              {branchName
                ? t('campaignDashboard.scopeOneBranch', { branchName })
                : t('campaignDashboard.scopeAllBranches')}
            </p>
          </div>
        </section>

        <section className={styles.panel} data-panel="terms" aria-labelledby="campaign-terms">
          <div className={styles.panelHeader}>
            <h2 id="campaign-terms">{t('campaignDashboard.termsHeading')}</h2>
          </div>
          <div className={styles.panelBody}>
            {terms.length === 0 ? (
              <p className={styles.muted}>{t('campaignDashboard.termsNone')}</p>
            ) : (
              <ul className={styles.terms}>
                {terms.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <section className={styles.preview} aria-labelledby="campaign-customer-preview">
        <h2 id="campaign-customer-preview">{t('campaignDashboard.previewHeading')}</h2>
        <RewardCard reward={reward} businessId={business.id} readOnly />
      </section>
    </div>
  );
}
