/**
 * Closed DTO of GET /network/feed (apps/api/src/community/community-feed.ts). Mirrored read-only here; the feed
 * exposes no internal ids, business ids, moderation data or customer data.
 */
export interface CommunityFeedItem {
  handle: string;
  contentClass: 'official' | 'business_post';
  businessName: string | null;
  body: string;
  linkUrl: string | null;
  contentLocale: string;
  publishedAt: string;
}

export interface CommunityFeedPage {
  items: CommunityFeedItem[];
  nextCursor: string | null;
}

/** A feed either has a real page or says honestly why it does not; a failure is never rendered as "empty". */
export type CommunityFeedResult =
  | { status: 'ready'; data: CommunityFeedPage }
  | { status: 'forbidden' | 'unavailable' };
