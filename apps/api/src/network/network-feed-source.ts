import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import type { FeedItemDto, FeedListInput, FeedPageDto, FeedSource } from '../community/community-feed';
import { isUuid } from '../lib/uuid';

/**
 * The restricted, read-only FeedSource over `network_*` (NETWORK-00 section 4 visibility predicate, official posts):
 * a post is visible only if it is published, its live revision is approved, and it has not expired. The database
 * clock decides expiry. Nothing here reads loyalty, points, feedback, survey, consent or messaging tables, takes a
 * customer id into the query, or writes anything. Pinned post first, then newest first; keyset cursor, no totals.
 */
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

type Position = { p: 0 | 1; t: string; i: string };

// Existing cursors contain ISO milliseconds; new ones retain PostgreSQL's six
// fractional digits. Never let Date normalize invalid dates into SQL inputs.
const CURSOR_TIME = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;

export function encodeFeedCursor(pos: Position): string {
  return btoa(JSON.stringify(pos)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeFeedCursor(cursor: string): Position | null {
  if (!CURSOR.test(cursor)) return null;
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const value = JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))) as Partial<Position>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if ((value.p !== 0 && value.p !== 1) || typeof value.t !== 'string' || typeof value.i !== 'string') return null;
    if (!CURSOR_TIME.test(value.t) || !isUuid(value.i)) return null;
    const time = new Date(value.t);
    if (Number.isNaN(time.getTime()) || time.toISOString() !== `${value.t.slice(0, 23)}Z`) return null;
    return { p: value.p, t: value.t, i: value.i };
  } catch {
    return null;
  }
}

export function createNetworkFeedSource(db: Database): FeedSource {
  return {
    async listVisible(input: FeedListInput): Promise<FeedPageDto> {
      const position = input.cursor ? decodeFeedCursor(input.cursor) : null;
      if (input.cursor && !position) return { items: [], nextCursor: null };
      const includeBusiness = input.includeBusinessPosts === true;
      const following = input.filter === 'following';
      // "Following" is only about business posts; with distribution closed it is simply empty (never an error that reveals state).
      if (following && !includeBusiness) return { items: [], nextCursor: null };

      // One visibility predicate, evaluated in the query and never cached (NETWORK-00 section 4): the post is published with an approved live
      // revision and not expired (database clock). A BUSINESS post is also visible only while distribution is open AND its public profile is
      // published AND its business is active; otherwise it is simply absent, with no signal of why. The customer id is used ONLY to look up the
      // customer's own explicit follows for the Following filter; there is no other personalisation, ranking or profiling.
      const pinnedRank = sql`case when p.pinned then 1 else 0 end`;
      const keyset = position
        ? sql`and (${pinnedRank} < ${position.p} or (${pinnedRank} = ${position.p} and (p.published_at < ${position.t}::timestamptz or (p.published_at = ${position.t}::timestamptz and p.id < ${position.i}::uuid))))`
        : sql``;
      const scope = following
        ? sql`p.content_class = 'business'`
        : sql`(p.content_class = 'official' or p.content_class = 'business')`;
      const followFilter = following
        ? sql`and exists (select 1 from network_follows f where f.customer_id = ${input.customerId}::uuid and f.business_id = p.business_id)`
        : sql``;
      const result = await db.execute(sql`
        select p.id, p.handle, p.pinned, p.content_class, p.published_at,
               to_char(p.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time,
               r.body, r.link_url, r.content_locale,
               pr.profile_handle as business_handle,
               coalesce(t1.display_name, t2.display_name) as business_name
          from network_posts p
          join network_post_revisions r on r.id = p.live_revision_id and r.status = 'approved'
          left join business_public_profiles pr on pr.business_id = p.business_id
          left join businesses b on b.id = p.business_id
          left join business_profile_revision_translations t1 on t1.revision_id = pr.published_revision_id and t1.locale = r.content_locale
          left join business_profile_revision_translations t2 on t2.revision_id = pr.published_revision_id and t2.locale = b.default_locale
         where p.state = 'published' and p.expires_at > now()
           and ${scope}
           and (p.content_class = 'official'
                or (${includeBusiness} and pr.publication_state = 'published' and b.status = 'active'))
           ${followFilter}
           ${keyset}
         order by ${pinnedRank} desc, p.published_at desc, p.id desc
         limit ${input.limit + 1}`);
      const rows = result.rows as Array<{
        id: string; handle: string; pinned: boolean; content_class: 'official' | 'business'; published_at: Date | string; cursor_time: string;
        body: string; link_url: string | null; content_locale: string; business_handle: string | null; business_name: string | null;
      }>;
      const page = rows.slice(0, input.limit);
      const items: FeedItemDto[] = page.map((row) => ({
        handle: row.handle,
        contentClass: row.content_class === 'business' ? 'business_post' : 'official',
        businessName: row.content_class === 'business' ? row.business_name : null,
        // Only a business post carries a profile handle; an official item keeps exactly the original closed shape.
        ...(row.content_class === 'business' ? { businessHandle: row.business_handle } : {}),
        body: row.body,
        linkUrl: row.link_url,
        contentLocale: row.content_locale,
        publishedAt: new Date(row.published_at).toISOString(),
      }));
      const last = page[page.length - 1];
      const nextCursor = rows.length > input.limit && last
        ? encodeFeedCursor({ p: last.pinned ? 1 : 0, t: last.cursor_time, i: last.id })
        : null;
      return { items, nextCursor };
    },
  };
}
