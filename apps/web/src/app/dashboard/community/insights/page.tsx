import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { CommunityFigure } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { getBusinessInsights, INSIGHT_RANGES, sanitizeRange } from '@/lib/business-insights';
import { communityHubGate } from '@/lib/workspace-guard';
import { MetricCard, OverviewPanel, WorkspaceState } from '@/components/workspace/overview-components';
import styles from '@/components/workspace/workspace.module.css';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Insights (BCOMM-05). Verified, privacy-thresholded engagement totals for this business only, from events the platform recorded itself (a post
 * shown to a signed-in customer, a link opened, a follow). A figure from fewer people than the group size is hidden; profile visits and loyalty
 * attribution are stated as NOT measured. Nothing is estimated, charted without data, or shown for another business.
 */
export default async function CommunityInsightsPage({ searchParams }: Props) {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const days = sanitizeRange((await searchParams)?.days);
  const [t, insights] = await Promise.all([getTranslations('businessCommunity.insights'), getBusinessInsights(business.id, days)]);

  const cell = (figure: CommunityFigure, min: number) => figure.state === 'shown'
    ? { text: String(figure.value), hint: '' }
    : { text: t('suppressedShort'), hint: t('suppressed', { min }) };
  return (
    <OverviewPanel title={t('title')}>
      <p className="text-sm text-neutral-600">{t('description')}</p>
      <nav aria-label={t('rangeLabel')} className="mt-3 flex flex-wrap gap-2 text-sm">
        {INSIGHT_RANGES.map((range) => (
          <Link key={range} href={`/dashboard/community/insights?days=${range}`} aria-current={range === days ? 'page' : undefined}
            className={`rounded-md border px-3 py-1 ${range === days ? 'border-neutral-900 font-semibold' : 'border-neutral-200 text-neutral-600'}`}>
            {t('range', { days: range })}
          </Link>
        ))}
      </nav>
      {insights.state === 'forbidden' ? (
        <WorkspaceState>{t('forbidden')}</WorkspaceState>
      ) : insights.state === 'unavailable' ? (
        <WorkspaceState>{t('unavailableTitle')}</WorkspaceState>
      ) : (
        <>
          <p className="mt-3 text-xs text-neutral-600" data-testid="community-insights-period">{t('period', { from: insights.data.from, to: insights.data.to })}</p>
          <div className={`${styles.metricGrid} mt-3`} data-testid="community-insights">
            {([
              ['impressions', 'chart', insights.data.impressions], ['reach', 'users', insights.data.uniqueReach], ['engagements', 'chart', insights.data.engagements],
              ['newFollowers', 'users', insights.data.newFollowers], ['followers', 'users', insights.data.currentFollowers],
            ] as const).map(([key, icon, figure]) => {
              const { text, hint } = cell(figure, insights.data.minimumGroupSize);
              return (
                <MetricCard key={key} label={t(`metrics.${key}.label`)} icon={icon} hint={hint || t(`metrics.${key}.hint`)}
                  value={figure.state === 'shown' ? text : <span className="text-base font-semibold leading-snug">{text}</span>} />
              );
            })}
          </div>
          <h3 className="mt-5 text-sm font-semibold">{t('postsTitle')}</h3>
          {insights.data.posts.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-600">{t('postsEmpty')}</p>
          ) : (
            <ul className="mt-2 space-y-2" data-testid="community-insights-posts">
              {insights.data.posts.map((post) => (
                <li key={post.handle} className="rounded-md border border-neutral-200 p-3 text-sm">
                  <p dir="auto">{post.excerpt}</p>
                  <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-600">
                    {([['impressions', post.impressions], ['reach', post.uniqueReach], ['engagements', post.engagements]] as const).map(([k, f]) => (
                      <div key={k} className="flex gap-1"><dt>{t(`metrics.${k}.label`)}:</dt><dd>{f.state === 'shown' ? f.value : t('suppressedShort')}</dd></div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-5 text-sm font-semibold">{t('notMeasuredTitle')}</h3>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-neutral-600" data-testid="community-insights-notmeasured">
            <li>{t('notMeasured.visits')}</li>
            <li>{t('notMeasured.attribution')}</li>
          </ul>
          <p className="mt-3 text-xs text-neutral-600">{t('privacy')}</p>
        </>
      )}
    </OverviewPanel>
  );
}
