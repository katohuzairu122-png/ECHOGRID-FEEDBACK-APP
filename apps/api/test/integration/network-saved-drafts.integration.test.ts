import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDb } from '../../src/db/client';
import {
  getNetworkSavedDraft,
  listNetworkSavedDrafts,
  NETWORK_DRAFT_PAGE_SIZE,
} from '../../src/network/network-saved-drafts';

describe.skipIf(!process.env.DATABASE_URL)('saved official drafts (PostgreSQL)', () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const db = buildDb(client);
  const handles: string[] = [];
  let author: string;
  let otherAuthor: string;
  let foreign: string;
  let submitted: string;
  let withdrawn: string;
  let saved: string;
  const timestamp = '2026-11-17T12:00:00.000001Z';
  const body = 'A'.repeat(150);

  async function addPost(owner: string, state = 'unpublished', revisionState = 'draft') {
    const handle = randomUUID().replaceAll('-', '').slice(0, 22);
    const id = (
      await client.query<{ id: string }>(
        'insert into network_posts(handle,author_user_id) values ($1,$2) returning id',
        [handle, owner],
      )
    ).rows[0]!.id;
    await client.query(
      `insert into network_post_revisions(post_id,revision_no,body,link_url,content_locale,content_digest,created_by,created_at,status,submitted_at)
       values ($1,1,$2,'https://example.test','en',$3,$4,$5,$6, $7)`,
      [
        id,
        body,
        'a'.repeat(64),
        owner,
        timestamp,
        revisionState,
        revisionState === 'submitted' ? timestamp : null,
      ],
    );
    if (state === 'withdrawn')
      await client.query("update network_posts set state = 'withdrawn' where id = $1", [id]);
    return { handle, id };
  }

  beforeAll(async () => {
    await client.connect();
    await client.query('begin');
    const addUser = async () =>
      (
        await client.query<{ id: string }>(
          "insert into users(email,password_hash,full_name,status,platform_role) values ($1,'unused','Synthetic','active','admin') returning id",
          [`drafts-${randomUUID()}@example.test`],
        )
      ).rows[0]!.id;
    author = await addUser();
    otherAuthor = await addUser();
    foreign = (await addPost(otherAuthor)).handle;
    submitted = (await addPost(author, 'unpublished', 'submitted')).handle;
    withdrawn = (await addPost(author, 'withdrawn')).handle;
    for (let index = 0; index <= NETWORK_DRAFT_PAGE_SIZE; index++) {
      const row = await addPost(author);
      handles.push(row.handle);
      if (index === 0) {
        saved = row.handle;
        await client.query(
          `insert into audit_log(actor_user_id,entity_type,entity_id,action,created_at,metadata)
           values ($1,'network_post',$2,'network.post_draft_saved','2026-11-17T12:01:00Z','{"revisionNo":1,"private":"never returned"}'),
                  ($1,'network_post',$2,'network.post_draft_saved','2026-11-17T12:02:00Z','{"revisionNo":2}')`,
          [author, row.id],
        );
      }
    }
  });

  afterAll(async () => {
    await client.query('rollback');
    await client.end();
  });

  it('pages deterministically across tied timestamps and bounds previews and projected fields', async () => {
    const first = await listNetworkSavedDrafts(db, author);
    expect(first.entries).toHaveLength(NETWORK_DRAFT_PAGE_SIZE);
    const [createdAt, handle] = first.nextCursor!.split('~') as [string, string];
    const second = await listNetworkSavedDrafts(db, author, { createdAt, handle });
    expect(second.nextCursor).toBeNull();
    const entries = [...first.entries, ...second.entries];
    expect(entries.map((entry) => entry.handle)).toEqual([...handles].sort().reverse());
    expect(entries.find((entry) => entry.handle === saved)).toEqual({
      handle: saved,
      preview: body.slice(0, 120),
      createdAt: '2026-11-17T12:00:00.000Z',
      lastSavedAt: '2026-11-17T12:01:00.000Z',
    });
    expect(entries.filter((entry) => entry.lastSavedAt === null)).toHaveLength(
      NETWORK_DRAFT_PAGE_SIZE,
    );
  });

  it('keeps other authors and non-editable revisions out and returns repeatable, read-only detail', async () => {
    for (const handle of [foreign, submitted, withdrawn, 'A'.repeat(22)]) {
      expect(await getNetworkSavedDraft(db, author, handle)).toBeNull();
    }
    expect(await getNetworkSavedDraft(db, otherAuthor, saved)).toBeNull();
    const expected = { handle: saved, body, contentLocale: 'en', linkUrl: 'https://example.test' };
    const before = await client.query('select * from network_post_revisions order by id');
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => getNetworkSavedDraft(db, author, saved)),
    );
    expect(concurrent).toEqual(Array.from({ length: 4 }, () => expected));
    const after = await client.query('select * from network_post_revisions order by id');
    expect(after.rows).toEqual(before.rows);
  });
});
