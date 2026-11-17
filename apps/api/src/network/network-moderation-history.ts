import {
  NETWORK_MODERATION_HISTORY_STATUS,
  type NetworkModerationHistoryAction,
  type NetworkModerationHistoryPageDto,
} from '@echo-grid-feedback/shared-types';
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client';
import { auditLog } from '../db/schema/audit-log';
import { networkPosts, networkPostRevisions } from '../db/schema/network-posts';

export const NETWORK_HISTORY_PAGE_SIZE = 25;
const actions = Object.keys(NETWORK_MODERATION_HISTORY_STATUS) as NetworkModerationHistoryAction[];
const revisionActions = ['network.revision_approved', 'network.post_published'];

export async function listNetworkModerationHistory(
  db: Database,
  cursor: string | undefined,
): Promise<NetworkModerationHistoryPageDto> {
  const entry = auditLog;
  const anchor = alias(auditLog, 'history_anchor');
  const boundary = cursor
    ? sql`(${entry.createdAt}, ${entry.id}) < (${db
        .select({ createdAt: anchor.createdAt, id: anchor.id })
        .from(anchor)
        .where(
          and(
            eq(anchor.id, cursor),
            eq(anchor.entityType, 'network_post'),
            isNull(anchor.businessId),
            inArray(anchor.action, actions),
          ),
        )})`
    : undefined;

  // Approval records historically store a revision ID in entity_id. All
  // other events store a post ID. Keep unmatched audit rows visible.
  const rows = await db
    .select({
      id: entry.id,
      occurredAt: entry.createdAt,
      action: entry.action,
      actorUserId: entry.actorUserId,
      postHandle: networkPosts.handle,
    })
    .from(entry)
    .leftJoin(
      networkPostRevisions,
      and(inArray(entry.action, revisionActions), eq(networkPostRevisions.id, entry.entityId)),
    )
    .leftJoin(
      networkPosts,
      and(
        eq(networkPosts.contentClass, 'official'),
        or(
          eq(networkPosts.id, networkPostRevisions.postId),
          and(notInArray(entry.action, revisionActions), eq(networkPosts.id, entry.entityId)),
        ),
      ),
    )
    .where(
      and(
        eq(entry.entityType, 'network_post'),
        isNull(entry.businessId),
        inArray(entry.action, actions),
        boundary,
      ),
    )
    .orderBy(desc(entry.createdAt), desc(entry.id))
    .limit(NETWORK_HISTORY_PAGE_SIZE + 1);

  const page = rows.slice(0, NETWORK_HISTORY_PAGE_SIZE);
  return {
    entries: page.map(({ occurredAt, action, actorUserId, postHandle }) => ({
      occurredAt: occurredAt.toISOString(),
      action: action as NetworkModerationHistoryAction,
      status: NETWORK_MODERATION_HISTORY_STATUS[action as NetworkModerationHistoryAction],
      actorUserId,
      postHandle,
    })),
    nextCursor: rows.length > NETWORK_HISTORY_PAGE_SIZE ? page.at(-1)!.id : null,
  };
}
