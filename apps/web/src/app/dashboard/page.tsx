import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { managementGate } from '@/lib/workspace-guard';
import { getCurrentUser } from '@/lib/platform';
import { getBusinessOverview, trendTotals } from '@/lib/business-overview';
import {
  MetricCard,
  OverviewPanel,
  WorkspaceState,
} from '@/components/workspace/overview-components';
import { LandingIcon } from '@/components/landing/landing-icon';
import { Button, Select, SentimentTrendChart, buttonVariants } from '@/components/ui';
import styles from '@/components/workspace/workspace.module.css';
import { SentimentBreakdown } from '@/components/workspace/sentiment-breakdown';
import { CreateBusinessForm } from './create-business-form';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ branch?: string | string[] }>;
}) {
  const business = await getActiveBusiness();
  if (!business) return <CreateBusinessForm />;
  // Cashiers land on "Serve customers"; an unconfirmed permission set shows a restricted state.
  const blocked = await managementGate();
  if (blocked) return blocked;
  const rawBranch = (await searchParams)?.branch;
  const requestedBranch =
    typeof rawBranch === 'string' && rawBranch.length <= 64 ? rawBranch : undefined;
  const [t, format, user, data] = await Promise.all([
    getTranslations('dashboard.overview'),
    getFormatter(),
    getCurrentUser(),
    getBusinessOverview(business.id, requestedBranch),
  ]);
  const chart = await getTranslations('analytics.page.chart');
  const totals = data.trend.status === 'ready' ? trendTotals(data.trend.data) : null;
  const unavailable = (status: string) => t(status === 'forbidden' ? 'forbidden' : 'unavailable');
  const count = (value: number) => format.number(value);
  const branchList = data.branches.status === 'ready' ? data.branches.data : [];
  const activeBranch =
    data.branchFilter.status === 'active'
      ? branchList.find((b) => b.id === data.branchFilter.branchId)
      : undefined;
  return (
    <div className={styles.overview}>
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>{business.name}</p>
          <h1>{t('title')}</h1>
          <p className={styles.muted}>{t('description')}</p>
        </div>
        <Link href="/dashboard/branches" className={buttonVariants({ variant: 'primary' })}>
          {t('viewBranches')}
        </Link>
      </header>
      {branchList.length > 1 && (
        <form method="get" className={styles.filterBar} aria-describedby="branch-filter-note">
          <label htmlFor="branch-filter">{t('branchFilterLabel')}</label>
          <Select id="branch-filter" name="branch" defaultValue={activeBranch?.id ?? ''}>
            <option value="">{t('allBranches')}</option>
            {branchList.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            {t('applyFilter')}
          </Button>
          <p id="branch-filter-note" className={styles.muted}>
            {activeBranch ? t('branchFilterActive', { name: activeBranch.name }) + '. ' : ''}
            {data.branchFilter.status === 'invalid' ? t('branchFilterInvalid') + ' ' : ''}
            {t('branchFilterNote')}
          </p>
        </form>
      )}
      <div className={styles.metricGrid}>
        <MetricCard
          icon="chat"
          label={t('analyzed')}
          value={totals ? count(totals.total) : '—'}
          hint={totals ? t('period') : unavailable(data.trend.status)}
        />
        <MetricCard
          icon="chart"
          label={t('positive')}
          value={
            totals?.positiveRate != null
              ? format.number(totals.positiveRate, { style: 'percent', maximumFractionDigits: 0 })
              : '—'
          }
          hint={
            totals
              ? t(totals.total === 0 ? 'noClassified' : 'classifiedOnly')
              : unavailable(data.trend.status)
          }
        />
        <MetricCard
          icon="star"
          label={t('loyaltyPreview')}
          value={data.loyalty.status === 'ready' ? count(data.loyalty.data.length) : '—'}
          hint={data.loyalty.status === 'ready' ? t('upToFive') : unavailable(data.loyalty.status)}
        />
        <MetricCard
          icon="bell"
          label={t('priority')}
          value={
            data.priority.status === 'ready'
              ? count(data.priority.data.items.length) + (data.priority.data.hasMore ? '+' : '')
              : '—'
          }
          hint={
            data.priority.status === 'ready' ? t('priorityHint') : unavailable(data.priority.status)
          }
        />
      </div>
      <div className={styles.overviewGrid}>
        <OverviewPanel
          title={t('trend')}
          href="/dashboard/analytics"
          linkLabel={t('viewAnalytics')}
        >
          <p className={styles.muted}>{t('period')}</p>
          {data.trend.status !== 'ready' ? (
            <WorkspaceState>{unavailable(data.trend.status)}</WorkspaceState>
          ) : (
            <>
              <SentimentTrendChart
                points={data.trend.data}
                labels={{
                  empty: chart('empty'),
                  ariaLabel: chart('ariaLabel'),
                  positive: chart('positive'),
                  neutral: chart('neutral'),
                  negative: chart('negative'),
                }}
              />
              {totals && totals.total > 0 && (
                <>
                  <p className="sr-only">
                    {t('sentimentSummary', {
                      total: totals.total,
                      positive: totals.positive,
                      neutral: totals.neutral,
                      negative: totals.negative,
                    })}
                  </p>
                  <SentimentBreakdown
                    totals={totals}
                    labels={{
                      negative: chart('negative'),
                      neutral: chart('neutral'),
                      positive: chart('positive'),
                    }}
                    formatCount={count}
                    formatRate={(fraction) =>
                      format.number(fraction, { style: 'percent', maximumFractionDigits: 0 })
                    }
                  />
                </>
              )}
              {data.trend.data.length > 0 && (
                <details className="mt-4 text-xs">
                  <summary className="cursor-pointer py-3">{t('viewData')}</summary>
                  <div className="overflow-x-auto">
                    <table className="text-start">
                      <caption className="sr-only">{t('trend')}</caption>
                      <thead>
                        <tr>
                          <th>{t('date')}</th>
                          <th>{chart('positive')}</th>
                          <th>{chart('neutral')}</th>
                          <th>{chart('negative')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.trend.data.map((point) => (
                          <tr key={point.bucket}>
                            <th scope="row">{point.bucket}</th>
                            <td>{count(point.positive)}</td>
                            <td>{count(point.neutral)}</td>
                            <td>{count(point.negative)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </>
          )}
        </OverviewPanel>
        <OverviewPanel title={t('quickActions')}>
          <div className={styles.quickActions}>
            <Link href="/dashboard/branches">
              <LandingIcon name="qr" width={24} height={24} />
              {t('branchQr')}
            </Link>
            <Link href="/dashboard/feedback/forms">
              <LandingIcon name="chat" width={24} height={24} />
              {t('forms')}
            </Link>
            <Link href="/dashboard/loyalty/scan">
              <LandingIcon name="star" width={24} height={24} />
              {t('scanCustomer')}
            </Link>
            <Link href="/dashboard/settlements">
              <LandingIcon name="gift" width={24} height={24} />
              {t('settlements')}
            </Link>
          </div>
          <p className="mt-4 text-xs text-neutral-500">
            {data.branches.status === 'ready'
              ? t('branchCount', { count: data.branches.data.length })
              : unavailable(data.branches.status)}
          </p>
        </OverviewPanel>
        <OverviewPanel
          title={t('recentFeedback')}
          href="/dashboard/feedback"
          linkLabel={t('viewAll')}
        >
          {data.feedback.status !== 'ready' ? (
            <WorkspaceState>{unavailable(data.feedback.status)}</WorkspaceState>
          ) : data.feedback.data.items.length === 0 ? (
            <WorkspaceState>{t('noFeedback')}</WorkspaceState>
          ) : (
            <ul className={styles.rows}>
              {data.feedback.data.items.map((item) => (
                <li key={item.id}>
                  <p>{item.comment || t('ratingOnly')}</p>
                  <div className={styles.rowMeta}>
                    <span>
                      {item.rating == null ? t('noRating') : t('rating', { rating: item.rating })}
                    </span>
                    <time dateTime={item.createdAt}>
                      {format.dateTime(new Date(item.createdAt), 'short')}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </OverviewPanel>
        <OverviewPanel
          title={t('priority')}
          href="/dashboard/feedback?savedView=high_priority_unresolved"
          linkLabel={t('review')}
        >
          {data.priority.status !== 'ready' ? (
            <WorkspaceState>{unavailable(data.priority.status)}</WorkspaceState>
          ) : data.priority.data.items.length === 0 ? (
            <WorkspaceState>{t('noPriority')}</WorkspaceState>
          ) : (
            <ul className={styles.rows}>
              {data.priority.data.items.map((item) => (
                <li key={item.id}>
                  <p>{item.comment || t('ratingOnly')}</p>
                  <Link
                    className="text-xs"
                    href="/dashboard/feedback?savedView=high_priority_unresolved"
                  >
                    {t('review')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </OverviewPanel>
        <OverviewPanel title={t('loyalty')} href="/dashboard/loyalty" linkLabel={t('viewAll')}>
          <p className={styles.muted}>{t('loyaltyHint')}</p>
          {data.loyalty.status !== 'ready' ? (
            <WorkspaceState>{unavailable(data.loyalty.status)}</WorkspaceState>
          ) : data.loyalty.data.length === 0 ? (
            <WorkspaceState>{t('noLoyalty')}</WorkspaceState>
          ) : (
            <ul className={styles.rows}>
              {data.loyalty.data.map((account) => (
                <li key={account.id}>
                  <p>{account.customer.fullName || t('customer')}</p>
                  <div className={styles.rowMeta}>
                    <span>{t('points', { count: account.points })}</span>
                    <span>{t('visits', { count: account.visitCount })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </OverviewPanel>
        {user?.platformRole && (
          <OverviewPanel title={t('platform')} href="/platform" linkLabel={t('openPlatform')}>
            <p className={styles.muted}>{t('platformHint')}</p>
          </OverviewPanel>
        )}
      </div>
    </div>
  );
}
