import type {
  NetworkSavedDraftDto,
  NetworkSavedDraftPageDto,
} from '@echo-grid-feedback/shared-types';
import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { auditLog } from '../db/schema/audit-log';
import { networkPostRevisions as revision, networkPosts as post } from '../db/schema/network-posts';

export const NETWORK_DRAFT_PAGE_SIZE = 25;
export type NetworkDraftCursor = { createdAt: string; handle: string };

const editableBy = (actorId: string) =>
  and(
    eq(post.authorUserId, actorId),
    eq(post.contentClass, 'official'),
    ne(post.state, 'withdrawn'),
    eq(revision.status, 'draft'),
  );

export async function listNetworkSavedDrafts(
  db: Database,
  actorId: string,
  cursor?: NetworkDraftCursor,
): Promise<NetworkSavedDraftPageDto> {
  // Match the cursor's JavaScript timestamp precision on both sides of the keyset.
  const createdAt = sql`date_trunc('milliseconds', ${revision.createdAt})`;
  const after = cursor
    ? or(
        sql`${createdAt} < ${cursor.createdAt}::timestamptz`,
        and(sql`${createdAt} = ${cursor.createdAt}::timestamptz`, lt(post.handle, cursor.handle)),
      )
    : undefined;

  // In-place saves have no update timestamp on the revision. Use existing,
  // revision-specific save events and keep missing audit evidence nullable.
  const lastSave = db
    .select({
      savedAt: sql<
        string | null
      >`to_char(max(${auditLog.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'network_post'),
        eq(auditLog.entityId, post.id),
        eq(auditLog.actorUserId, actorId),
        eq(auditLog.action, 'network.post_draft_saved'),
        sql`${auditLog.businessId} is null`,
        sql`${auditLog.metadata} ->> 'revisionNo' = ${revision.revisionNo}::text`,
      ),
    );

  const rows = await db
    .select({
      handle: post.handle,
      preview: sql<string>`left(${revision.body}, 120)`,
      createdAt: revision.createdAt,
      lastSavedAt: sql<string | null>`(${lastSave})`,
    })
    .from(revision)
    .innerJoin(post, eq(post.id, revision.postId))
    .where(and(editableBy(actorId), after))
    .orderBy(desc(createdAt), desc(post.handle))
    .limit(NETWORK_DRAFT_PAGE_SIZE + 1);

  const entries = rows.slice(0, NETWORK_DRAFT_PAGE_SIZE).map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
  const last = entries.at(-1);
  return {
    entries,
    nextCursor:
      last && rows.length > NETWORK_DRAFT_PAGE_SIZE ? `${last.createdAt}~${last.handle}` : null,
  };
}

export async function getNetworkSavedDraft(
  db: Database,
  actorId: string,
  handle: string,
): Promise<NetworkSavedDraftDto | null> {
  const [draft] = await db
    .select({
      handle: post.handle,
      body: revision.body,
      contentLocale: revision.contentLocale,
      linkUrl: revision.linkUrl,
    })
    .from(revision)
    .innerJoin(post, eq(post.id, revision.postId))
    .where(and(editableBy(actorId), eq(post.handle, handle)))
    .limit(1);
  return draft ?? null;
}
