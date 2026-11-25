import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { communityHubGate } from '@/lib/workspace-guard';
import { OverviewPanel, WorkspaceState } from '@/components/workspace/overview-components';

const PLANNED = ['impressions', 'engagement', 'visits', 'followers', 'attribution', 'acquisition'] as const;

/** Insights. Nothing is measured yet (BCOMM-05), so no view, follower, engagement, acquisition or conversion figure is shown or invented. */
export default async function CommunityInsightsPage() {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  if (!(await getActiveBusiness())) redirect('/dashboard');
  const t = await getTranslations('businessCommunity.insights');
  return (
    <OverviewPanel title={t('title')}>
      <p className="text-sm text-neutral-600">{t('description')}</p>
      <WorkspaceState>{t('unavailableTitle')}</WorkspaceState>
      <p className="mt-3 text-sm text-neutral-600">{t('unavailable')}</p>
      <h3 className="mt-4 text-sm font-semibold">{t('plannedTitle')}</h3>
      <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-neutral-600" data-testid="community-insights-planned">
        {PLANNED.map((key) => (<li key={key}>{t(`planned.${key}`)}</li>))}
      </ul>
    </OverviewPanel>
  );
}
