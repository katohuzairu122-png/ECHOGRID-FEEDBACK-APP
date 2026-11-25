import 'server-only';
import { networkFeedPageSchema } from '@echo-grid-feedback/shared-types';
import { ApiError } from './api-error';
import { customerApiFetch } from './customer-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';
import type { CommunityFeedResult } from './community-feed-types';

export const COMMUNITY_FEED_PAGE_SIZE = 20;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

export type FeedFilter = 'all' | 'following';
/** Only the two documented values are accepted; anything else is the default view. */
export function sanitizeFeedFilter(raw: string | string[] | undefined): FeedFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'following' ? 'following' : 'all';
}

/** Accepts only a well-formed opaque cursor; anything else is dropped (first page), never forwarded. */
export function sanitizeFeedCursor(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && CURSOR.test(value) ? value : null;
}

/**
 * One read of the customer feed. customerApiFetch redirects to the customer login on a 401 (control flow,
 * re-thrown); an explicit phone requirement is distinct from other 403 denials; anything else -> `unavailable`. A failure is never turned into an empty feed.
 */
export async function getCommunityFeed(cursor: string | null = null, filter: FeedFilter = 'all'): Promise<CommunityFeedResult> {
  const query = new URLSearchParams({ limit: String(COMMUNITY_FEED_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  if (filter === 'following') query.set('filter', 'following');
  try {
    const raw = await customerApiFetch<unknown>(`/network/feed?${query}`, {
      cache: 'no-store',
    });
    const data = networkFeedPageSchema.parse(raw);
    if (data.items.length > COMMUNITY_FEED_PAGE_SIZE) throw new Error('Invalid Feed page size');
    return { status: 'ready', data };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError && error.status === 403 && error.code === 'PHONE_VERIFICATION_REQUIRED') {
      return { status: 'verification_required' };
    }
    return {
      status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable',
    };
  }
}
