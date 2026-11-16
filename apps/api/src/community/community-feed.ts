/**
 * COMMUNITY-01 Feed foundation: the read contract and the only safe default source.
 *
 * NETWORK-00 (docs/architecture/builds/NETWORK) is a DESIGN PROPOSAL: no post, moderation, audience-eligibility
 * or ownership policy is approved and no feed table exists. This module therefore defines only the closed
 * customer-facing DTO and a `FeedSource` port. The sole implementation shipped is `emptyFeedSource`, which
 * returns no items. A future, separately authorized block supplies a real source that applies the NETWORK-00
 * visibility predicate; nothing here reads loyalty, points, feedback, survey, consent or messaging data.
 */

export const FEED_CONTENT_CLASSES = ['official', 'business_post'] as const;
export type FeedContentClass = (typeof FEED_CONTENT_CLASSES)[number];

/** Closed DTO (NETWORK-00 section 8): no internal ids, business ids, reviewer identities or moderation data. */
export interface FeedItemDto {
  handle: string;
  contentClass: FeedContentClass;
  businessName: string | null;
  body: string;
  linkUrl: string | null;
  contentLocale: string;
  publishedAt: string;
}

export interface FeedPageDto {
  items: FeedItemDto[];
  nextCursor: string | null;
}

export interface FeedListInput {
  /** Derived from the authenticated session only; never from the request. */
  customerId: string;
  cursor: string | null;
  limit: number;
}

export interface FeedSource {
  listVisible(input: FeedListInput): Promise<FeedPageDto>;
}

/** No feed publication policy is approved, so there is nothing to show. Never fabricates activity. */
export const emptyFeedSource: FeedSource = {
  async listVisible() {
    return { items: [], nextCursor: null };
  },
};

const HANDLE = /^[A-Za-z0-9_-]{22}$/;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Re-projects a source row into the closed DTO. Anything that does not satisfy the contract throws so the
 * route fails closed instead of leaking an unexpected field or an unsafe link.
 */
export function toFeedItemDto(row: FeedItemDto): FeedItemDto {
  if (!HANDLE.test(row.handle)) throw new Error('feed item handle is invalid');
  if (!FEED_CONTENT_CLASSES.includes(row.contentClass)) throw new Error('feed item class is invalid');
  if (typeof row.body !== 'string' || row.body.length === 0 || row.body.length > 2000) {
    throw new Error('feed item body is invalid');
  }
  if (row.linkUrl !== null && !isHttpsUrl(row.linkUrl)) throw new Error('feed item link is invalid');
  if (Number.isNaN(Date.parse(row.publishedAt))) throw new Error('feed item time is invalid');
  return {
    handle: row.handle,
    contentClass: row.contentClass,
    businessName: row.businessName,
    body: row.body,
    linkUrl: row.linkUrl,
    contentLocale: row.contentLocale,
    publishedAt: row.publishedAt,
  };
}
