import 'server-only';
import { ApiError } from './api-error';
import { customerApiFetch } from './customer-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';
import type { CommunityFeedResult, CommunityFeedPage } from './community-feed-types';

export const COMMUNITY_FEED_PAGE_SIZE = 20;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/** Accepts only a well-formed opaque cursor; anything else is dropped (first page), never forwarded. */
export function sanitizeFeedCursor(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && CURSOR.test(value) ? value : null;
}

/**
 * One read of the customer feed. customerApiFetch redirects to the customer login on a 401 (control flow,
 * re-thrown); 403 -> `forbidden`; anything else -> `unavailable`. A failure is never turned into an empty feed.
 */
export async function getCommunityFeed(cursor: string | null = null): Promise<CommunityFeedResult> {
  const query = new URLSearchParams({ limit: String(COMMUNITY_FEED_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  try {
    const data = await customerApiFetch<CommunityFeedPage>(`/network/feed?${query}`, {
      cache: 'no-store',
    });
    return { status: 'ready', data };
  } catch (error) {
    rethrowControlFlow(error);
    return { status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable' };
  }
}
