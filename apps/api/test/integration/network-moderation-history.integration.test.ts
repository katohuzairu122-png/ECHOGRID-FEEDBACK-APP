import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDb } from '../../src/db/client';
import {
  listNetworkModerationHistory,
  NETWORK_HISTORY_PAGE_SIZE,
} from '../../src/network/network-moderation-history';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository';

describe.skipIf(!process.env.DATABASE_URL)('official moderation audit history (PostgreSQL)', () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const db = buildDb(client);
  const audit = new AuditLogRepository(db);
  const auditIds = Array.from(
    { length: NETWORK_HISTORY_PAGE_SIZE + 1 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  const tenantId = randomUUID();
  let actor: string;
  let handle: string;
  let postId: string;

  beforeAll(async () => {
    await client.connect();
    await client.query('begin');
    actor = (
      await client.query<{ id: string }>(
        "insert into users(email,password_hash,full_name,status,platform_role) values ($1,'unused','Sensitive name','active','admin') returning id",
        [`history-${randomUUID()}@example.test`],
      )
    ).rows[0]!.id;
    const business = (
      await client.query<{ id: string }>(
        "insert into businesses(name,slug) values ('Private tenant',$1) returning id",
        [`history-${randomUUID()}`],
      )
    ).rows[0]!.id;
    handle = randomUUID().replaceAll('-', '').slice(0, 22);
    postId = (
      await client.query<{ id: string }>(
        'insert into network_posts(handle, author_user_id) values ($1,$2) returning id',
        [handle, actor],
      )
    ).rows[0]!.id;
    const revisionId = (
      await client.query<{ id: string }>(
        `insert into network_post_revisions(post_id,revision_no,body,link_url,content_locale,content_digest,created_by)
       values ($1,1,'Private draft','https://example.test/hidden','en',$2,$3) returning id`,
        [postId, 'a'.repeat(64), actor],
      )
    ).rows[0]!.id;

    for (const [index, id] of auditIds.entries()) {
      const approval = index === auditIds.length - 1;
      await client.query(
        `insert into audit_log(id,actor_user_id,entity_type,entity_id,action,created_at,metadata,ip_address,user_agent)
         values ($1,$2,'network_post',$3,$4,'2090-01-01T00:00:00.000001Z',$5,'192.0.2.1','Sensitive agent')`,
        [
          id,
          actor,
          approval ? revisionId : postId,
          approval ? 'network.revision_approved' : 'network.post_draft_saved',
          JSON.stringify({ secret: 'synthetic sensitive field' }),
        ],
      );
    }
    await client.query(
      `insert into audit_log(id,business_id,actor_user_id,entity_type,entity_id,action,created_at)
       values ($1,$2,$3,'network_post',$4,'network.post_draft_saved','2091-01-01'),
              ($5,null,$3,'network_post',$4,'network.unapproved_event','2091-01-01'),
              ($6,null,$3,'business',$4,'network.post_draft_saved','2091-01-01')`,
      [tenantId, business, actor, postId, randomUUID(), randomUUID()],
    );
  });

  afterAll(async () => {
    await client.query('rollback');
    await client.end();
  });

  it('orders a tied timestamp by ID, resolves revision references, and projects only allowed fields', async () => {
    const first = await listNetworkModerationHistory(db, undefined);
    expect(first.entries).toHaveLength(NETWORK_HISTORY_PAGE_SIZE);
    expect(first.nextCursor).toBe(auditIds[1]);
    expect(first.entries[0]).toEqual({
      action: 'network.revision_approved',
      status: 'approval_recorded',
      actorUserId: actor,
      postHandle: handle,
      occurredAt: '2090-01-01T00:00:00.000Z',
    });
    expect(first.entries.every((entry) => entry.postHandle === handle)).toBe(true);

    const second = await listNetworkModerationHistory(db, first.nextCursor!);
    expect(second.entries[0]).toEqual({
      action: 'network.post_draft_saved',
      status: 'draft',
      actorUserId: actor,
      postHandle: handle,
      occurredAt: '2090-01-01T00:00:00.000Z',
    });
  });

  it('denies unrelated cursor anchors and filters moderation rows out of the general audit view when requested', async () => {
    for (const cursor of [tenantId, randomUUID()]) {
      expect(await listNetworkModerationHistory(db, cursor)).toEqual({
        entries: [],
        nextCursor: null,
      });
    }
    const generalRows = await audit.listAllWithDetails({
      actorUserId: actor,
      excludeNetworkModeration: true,
    });
    expect(generalRows.map((entry) => entry.entityType)).toEqual(['business']);
    expect(generalRows[0]?.entityId).toBe(postId);
    expect(
      await audit.listAllWithDetails({
        actorUserId: actor,
        entityType: 'network_post',
        excludeNetworkModeration: true,
      }),
    ).toEqual([]);
    const preserved = await audit.listAllWithDetails({
      actorUserId: actor,
      entityType: 'network_post',
    });
    expect(preserved).toHaveLength(auditIds.length + 2);
  });
});
