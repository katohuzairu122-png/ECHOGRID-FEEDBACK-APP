import { notFound } from 'next/navigation';
import { getCommunityFeed, sanitizeFeedCursor, sanitizeFeedFilter } from '@/lib/community-feed';
import { getFollowedHandles } from '@/lib/community-follows';
import { getNetworkFeedEnabled } from '@/lib/network-status';
import { CommunityFeedView } from './community-feed-view';

interface CommunityFeedPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Community > Feed (read-only foundation). Session protection: app/loyalty/dashboard/layout.tsx and
 * customerApiFetch (401 -> customer login). Reads only GET /network/feed; nothing here writes or publishes.
 */
export default async function CommunityFeedPage({ searchParams }: CommunityFeedPageProps) {
  // Feed disabled (default): the route does not exist for the customer, same as a path that was never built.
  if (!(await getNetworkFeedEnabled())) notFound();
  const params = await searchParams;
  const cursor = sanitizeFeedCursor(params.cursor);
  const filter = sanitizeFeedFilter(params.filter);
  const [result, followed] = await Promise.all([getCommunityFeed(cursor, filter), getFollowedHandles()]);
  return <CommunityFeedView result={result} cursor={cursor} filter={filter} followed={followed} />;
}
