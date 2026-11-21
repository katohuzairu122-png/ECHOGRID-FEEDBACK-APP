/**
 * Closed DTO of GET /network/feed (apps/api/src/community/community-feed.ts). Mirrored read-only here; the feed
 * exposes no internal ids, business ids, moderation data or customer data.
 */
import type { NetworkFeedItemDto, NetworkFeedPageDto } from '@echo-grid-feedback/shared-types';

export type CommunityFeedItem = NetworkFeedItemDto;
export type CommunityFeedPage = NetworkFeedPageDto;

/** A feed either has a real page or says honestly why it does not; a failure is never rendered as "empty". */
export type CommunityFeedResult =
  { status: 'ready'; data: CommunityFeedPage } | { status: 'forbidden' | 'unavailable' };
