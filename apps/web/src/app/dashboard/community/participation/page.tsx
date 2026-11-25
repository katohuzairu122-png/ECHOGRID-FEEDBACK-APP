import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { communityHubGate } from '@/lib/workspace-guard';
import { MetricCard, OverviewPanel, WorkspaceState } from '@/components/workspace/overview-components';
import styles from '@/components/workspace/workspace.module.css';

/**
 * Participation. No approved aggregate service exists yet (BCOMM-02), so this is an explicit unavailable state. It requests no customer data of any
 * kind and shows no number: never an individual membership, a points balance, another business's customers or a cross-business relationship.
 */
export default async function CommunityParticipationPage() {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  if (!(await getActiveBusiness())) redirect('/dashboard');
  const t = await getTranslations('businessCommunity.participation');
  return (
    <OverviewPanel title={t('title')}>
      <p className="text-sm text-neutral-600">{t('description')}</p>
      <div className={`${styles.metricGrid} mt-3`} data-testid="community-participation">
        {(['eligible', 'participants', 'rate'] as const).map((key) => (
          <MetricCard key={key} label={t(`metrics.${key}`)} value={t('unavailableShort')} hint={t('unavailableTitle')} icon={key === 'rate' ? 'chart' : 'users'} />
        ))}
      </div>
      <WorkspaceState>{t('unavailable')}</WorkspaceState>
      <p className="mt-3 text-sm text-neutral-600">{t('privacy')}</p>
    </OverviewPanel>
  );
}
