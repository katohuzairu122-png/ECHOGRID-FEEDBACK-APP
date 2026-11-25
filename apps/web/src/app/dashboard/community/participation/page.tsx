import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { getBusinessCommunityParticipation } from '@/lib/business-community';
import { communityHubGate } from '@/lib/workspace-guard';
import { OverviewPanel, WorkspaceState } from '@/components/workspace/overview-components';
import { ParticipationMetrics } from '../participation-metrics';

/**
 * Participation (BCOMM-02). Privacy-protected TOTALS for this business only: its active loyalty customers, how many hold a Community membership
 * and the share. The server suppresses small groups; this page renders exactly what it is given. It never shows which customers joined, their
 * points, or anything about another business, and it performs no write.
 */
export default async function CommunityParticipationPage() {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const [t, result] = await Promise.all([getTranslations('businessCommunity.participation'), getBusinessCommunityParticipation(business.id)]);
  return (
    <OverviewPanel title={t('title')}>
      <p className="text-sm text-neutral-600">{t('description')}</p>
      <ParticipationMetrics result={result} testId="community-participation" labels={{ eligible: t('metrics.eligible'), participants: t('metrics.participants'), rate: t('metrics.rate') }} />
      <WorkspaceState>{result.state === 'ready' ? t('about') : t('unavailable')}</WorkspaceState>
      <p className="mt-3 text-sm text-neutral-600">{t('privacy')}</p>
    </OverviewPanel>
  );
}
