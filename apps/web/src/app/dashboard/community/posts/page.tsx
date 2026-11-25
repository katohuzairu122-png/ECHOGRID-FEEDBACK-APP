import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { communityHubGate } from '@/lib/workspace-guard';
import { OverviewPanel, WorkspaceState } from '@/components/workspace/overview-components';

/**
 * My Posts. Business publishing is not implemented (BDPN is design only), so this is a controlled unavailable state: no editor, no submit, no
 * button, no API call. It lists what will be managed later as plain words, never as counts.
 */
export default async function CommunityPostsPage() {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  if (!(await getActiveBusiness())) redirect('/dashboard');
  const t = await getTranslations('businessCommunity.posts');
  return (
    <OverviewPanel title={t('title')}>
      <p className="text-sm text-neutral-600">{t('description')}</p>
      <WorkspaceState>{t('unavailableTitle')}</WorkspaceState>
      <p className="mt-3 text-sm text-neutral-600">{t('unavailable')}</p>
      <h3 className="mt-4 text-sm font-semibold">{t('statesTitle')}</h3>
      <ul className="mt-2 flex flex-wrap gap-2 text-sm" data-testid="community-posts-states">
        {(['drafts', 'published', 'review', 'archived'] as const).map((key) => (
          <li key={key} className="rounded-md border border-neutral-200 px-3 py-1 text-neutral-600">{t(`states.${key}`)}</li>
        ))}
      </ul>
    </OverviewPanel>
  );
}
