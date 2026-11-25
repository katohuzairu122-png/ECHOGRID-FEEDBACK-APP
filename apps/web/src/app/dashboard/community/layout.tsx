import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { communityHubGate } from '@/lib/workspace-guard';
import styles from '@/components/workspace/workspace.module.css';
import { CommunityTabs } from './community-tabs';

/**
 * BCOMM-01: the single business Community hub. Gated for business managers only (cashiers go to Serve customers); opening it is read-only: it
 * enrolls nobody, records no consent, publishes nothing and changes no setting. Mandatory onboarding stays at /dashboard.
 */
export default async function CommunityLayout({ children }: { children: React.ReactNode }) {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const t = await getTranslations('businessCommunity');
  const items = [
    { href: '/dashboard/community', label: t('tabs.home') },
    { href: '/dashboard/community/participation', label: t('tabs.participation') },
    { href: '/dashboard/community/posts', label: t('tabs.posts') },
    { href: '/dashboard/community/insights', label: t('tabs.insights') },
  ];
  return (
    <div className={styles.overview} data-testid="community-hub">
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow} data-testid="community-business-name">{business.name}</p>
          <h1>{t('title')}</h1>
        </div>
      </header>
      <CommunityTabs items={items} label={t('tabs.label')} />
      {children}
    </div>
  );
}
