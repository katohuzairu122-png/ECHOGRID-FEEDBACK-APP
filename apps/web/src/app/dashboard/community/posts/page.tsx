import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { getBusinessCommunityStatus } from '@/lib/business-community';
import { getBusinessPosts } from '@/lib/business-posts';
import { communityHubGate } from '@/lib/workspace-guard';
import { OverviewPanel, WorkspaceState } from '@/components/workspace/overview-components';
import { PostsManager } from './posts-manager';

/**
 * My Posts (BCOMM-03). The business's own Community posts: drafts, posts awaiting platform review, live, rejected (with the moderator's reason),
 * suspended and archived. Writing (composer, submit, archive) is offered only while the SERVER reports publishing open AND the user may manage
 * posts; either way the API re-checks everything. When publishing is closed the history stays readable and nothing can be changed.
 */
export default async function CommunityPostsPage() {
  const blocked = await communityHubGate();
  if (blocked) return blocked;
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const [t, rollout, posts, locale, format] = await Promise.all([
    getTranslations('businessCommunity.posts'), getBusinessCommunityStatus(business.id), getBusinessPosts(business.id), getLocale(), getFormatter(),
  ]);
  const publishingOpen = rollout.state === 'ready' && rollout.status.publishing === 'open';
  return (
    <OverviewPanel title={t('title')}>
      <p className="text-sm text-neutral-600">{t('description')}</p>
      {posts.state === 'forbidden' ? (
        <WorkspaceState>{t('forbidden')}</WorkspaceState>
      ) : posts.state === 'unavailable' ? (
        <WorkspaceState>{t('unavailableTitle')}</WorkspaceState>
      ) : (
        <>
          {!publishingOpen ? <WorkspaceState>{rollout.state === 'ready' ? t('closed') : t('statusUnknown')}</WorkspaceState> : null}
          <p className="mt-2 text-xs text-neutral-600">{t('moderationNote')}</p>
          <div className="mt-3">
            <PostsManager
              posts={posts.posts}
              writable={publishingOpen}
              defaultLocale={locale}
              formatDate={Object.fromEntries(posts.posts.map((p) => [p.handle, format.dateTime(new Date(p.publishedAt ?? p.createdAt), { dateStyle: 'medium' })]))}
            />
          </div>
        </>
      )}
    </OverviewPanel>
  );
}
