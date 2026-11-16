import { getCommunityFeed, sanitizeFeedCursor } from '@/lib/community-feed';
import { CommunityFeedView } from './community-feed-view';

interface CommunityFeedPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Community > Feed (read-only foundation). Session protection: app/loyalty/dashboard/layout.tsx and
 * customerApiFetch (401 -> customer login). Reads only GET /network/feed; nothing here writes or publishes.
 */
export default async function CommunityFeedPage({ searchParams }: CommunityFeedPageProps) {
  const cursor = sanitizeFeedCursor((await searchParams).cursor);
  const result = await getCommunityFeed(cursor);
  return <CommunityFeedView result={result} cursor={cursor} />;
}
