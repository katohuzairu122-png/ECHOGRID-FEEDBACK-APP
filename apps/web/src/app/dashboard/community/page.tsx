import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { getBusinessCommunityParticipation, getBusinessCommunityStatus } from '@/lib/business-community';
import { communityHubGate } from '@/lib/workspace-guard';
import { redirect } from 'next/navigation';
import { OverviewPanel, WorkspaceState } from '@/components/workspace/overview-components';
import { ParticipationMetrics } from './participation-metrics';
import { RolloutStatus } from './rollout-status';

const ABOUT = ['what', 'differs', 'benefit', 'voluntary', 'publishing', 'privacy', 'rollout'] as const;

/**
 * Community Home. Everything here is explanatory or read-only. No customer, membership, consent, points or analytics figure is shown: the
 * participation summary shows only the server's privacy-protected totals (BCOMM-02), with small groups suppressed.
 */
export default async function CommunityHomePage() {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const [t, rollout, participation] = await Promise.all([getTranslations('businessCommunity'), getBusinessCommunityStatus(business.id), getBusinessCommunityParticipation(business.id)]);
  const feedOpen = rollout.state === 'ready' && rollout.status.feed === 'open';
  return (
    <div className="space-y-6">
      <section aria-labelledby="community-intro" className="space-y-2">
        <h2 id="community-intro" className="text-2xl font-bold">{t('tagline')}</h2>
        <p className="max-w-2xl text-sm text-neutral-600">{t('intro')}</p>
      </section>

      <RolloutStatus rollout={rollout} />

      <OverviewPanel title={t('summary.title')} href="/dashboard/community/participation" linkLabel={t('summary.link')}>
        <ParticipationMetrics result={participation} testId="community-summary" labels={{ eligible: t('summary.eligible'), participants: t('summary.participants'), rate: t('summary.rate') }} />
      </OverviewPanel>

      <OverviewPanel title={t('feed.title')}>
        <WorkspaceState>{feedOpen ? t('feed.openNotice') : t('feed.empty')}</WorkspaceState>
      </OverviewPanel>

      <OverviewPanel title={t('about.title')}>
        <dl className="grid gap-4 sm:grid-cols-2" data-testid="community-about">
          {ABOUT.map((key) => (
            <div key={key} className="space-y-1">
              <dt className="text-sm font-semibold">{t(`about.${key}.title`)}</dt>
              <dd className="text-sm text-neutral-600">{t(`about.${key}.body`)}</dd>
            </div>
          ))}
        </dl>
      </OverviewPanel>

      <p className="text-xs text-neutral-500">
        <Link href="/dashboard/overview" className="underline">{(await getTranslations('dashboard.overview'))('title')}</Link>
      </p>
    </div>
  );
}
