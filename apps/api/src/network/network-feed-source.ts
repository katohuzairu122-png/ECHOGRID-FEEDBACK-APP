import { and, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { networkPosts, networkPostRevisions } from '../db/schema/network-posts';
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

      const visible = and(
        eq(networkPosts.state, 'published'),
        eq(networkPostRevisions.status, 'approved'),
        gt(networkPosts.expiresAt, sql`now()`),
      );
      const pinnedRank = sql<number>`case when ${networkPosts.pinned} then 1 else 0 end`;
      const after = position
        ? or(
            lt(pinnedRank, position.p),
            and(
              sql`${pinnedRank} = ${position.p}`,
              or(
                sql`${networkPosts.publishedAt} < ${position.t}::timestamptz`,
                and(sql`${networkPosts.publishedAt} = ${position.t}::timestamptz`, lt(networkPosts.id, position.i)),
              ),
            ),
          )
        : undefined;

      const rows = await db.select({
        id: networkPosts.id,
        handle: networkPosts.handle,
        pinned: networkPosts.pinned,
        publishedAt: networkPosts.publishedAt,
        // Keep this internal cursor value out of the customer item DTO. JS Date
        // truncates microseconds and cannot represent the keyset boundary.
        cursorTime: sql<string>`to_char(${networkPosts.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        body: networkPostRevisions.body,
        linkUrl: networkPostRevisions.linkUrl,
        contentLocale: networkPostRevisions.contentLocale,
      })
        .from(networkPosts)
        .innerJoin(networkPostRevisions, eq(networkPostRevisions.id, networkPosts.liveRevisionId))
        .where(after ? and(visible, after) : visible)
        .orderBy(desc(pinnedRank), desc(networkPosts.publishedAt), desc(networkPosts.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const items: FeedItemDto[] = page.map((row) => ({
        handle: row.handle,
        contentClass: 'official',
        businessName: null,
        body: row.body,
        linkUrl: row.linkUrl,
        contentLocale: row.contentLocale,
        publishedAt: row.publishedAt!.toISOString(),
      }));
      const last = page[page.length - 1];
      const nextCursor = rows.length > input.limit && last
        ? encodeFeedCursor({ p: last.pinned ? 1 : 0, t: last.cursorTime, i: last.id })
        : null;
      return { items, nextCursor };
    },
  };
}
