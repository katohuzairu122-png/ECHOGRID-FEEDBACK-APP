import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { NetworkPostService } from '../../src/network/network-post.service';
import { createNetworkFeedSource } from '../../src/network/network-feed-source';

/**
 * NETWORK-01 against REAL Postgres: the official-post lifecycle, the database triggers that must hold even for a
 * direct SQL session (no application code), visibility and expiry from the database clock, the pinned-post rule,
 * concurrency on approval, and non-effect on every customer-facing ledger. Rows carry a per-run tag and are removed
 * afterwards where the schema allows (network rows are append-only by design, so the per-run users stay).
 */
describe.skipIf(!process.env.DATABASE_URL)('network official posts (integration)', () => {
  const RUN = Date.now().toString(36);
  let client: Client;
  let other: Client;
  let service: NetworkPostService;
  let feed: ReturnType<typeof createNetworkFeedSource>;
  let author: string;
  let admin1: string;
  let admin2: string;
  let admin3: string;
  const customer = '00000000-0000-4000-8000-000000000001';

  const user = async (label: string, role: string | null) =>
    (await client.query<{ id: string }>(
      'INSERT INTO users(email,password_hash,full_name,status,platform_role) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [`net01-${label}-${RUN}@example.test`, 'unused', label, 'active', role],
    )).rows[0]!.id;

  const content = (body = 'Welcome to the Echo Grid Community.', over: Record<string, unknown> = {}) =>
    ({ body, contentLocale: 'en', linkUrl: 'https://echogrid.example/news', ...over });

  /** Create, submit and approve twice. Returns the post and the approved revision id. */
  async function publish(body = `Post ${Math.random()}`, authorId = author) {
    const { post, revision } = await service.createDraft(authorId, content(body));
    await service.submit(post.id, authorId);
    await service.approve(revision.id, admin1);
    const outcome = await service.approve(revision.id, admin2);
    expect(outcome.status).toBe('published');
    return { post, revisionId: revision.id };
  }

  const visible = async (limit = 50) => (await feed.listVisible({ customerId: customer, cursor: null, limit })).items;
  const counts = async () => (await client.query(`
    SELECT (SELECT count(*) FROM loyalty_accounts) la, (SELECT count(*) FROM loyalty_transactions) lt,
           (SELECT count(*) FROM community_memberships) cm, (SELECT count(*) FROM community_point_accounts) cpa,
           (SELECT count(*) FROM community_point_transactions) cpt, (SELECT count(*) FROM customers) c`)).rows[0];

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    other = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await other.connect();
    service = new NetworkPostService(buildDb(client));
    feed = createNetworkFeedSource(buildDb(client));
    // Isolate this run's visibility: nothing else in the table may be published while these tests count items.
    await client.query("UPDATE network_posts SET state = 'withdrawn' WHERE state IN ('published','suspended') AND handle NOT LIKE 'zzzz%'").catch(() => undefined);
    author = await user('author', 'admin');
    admin1 = await user('admin1', 'admin');
    admin2 = await user('admin2', 'admin');
    admin3 = await user('admin3', 'admin');
  });

  afterAll(async () => {
    await client.end();
    await other.end();
  });

  describe('lifecycle and separation of duties', () => {
    it('publishes only after TWO distinct non-author approvers, with expiry 30 days from the database clock', async () => {
      const { post, revision } = await service.createDraft(author, content('Two approvals needed.'));
      expect(await visible()).toHaveLength(0);
      await service.submit(post.id, author);
      expect(await service.approve(revision.id, admin1)).toMatchObject({ status: 'recorded', approvals: 1, required: 2 });
      expect(await visible()).toHaveLength(0);
      const done = await service.approve(revision.id, admin2);
      expect(done.status).toBe('published');
      const [row] = (await client.query("SELECT state, expires_at - published_at AS span FROM network_posts WHERE id=$1", [post.id])).rows;
      expect(row.state).toBe('published');
      expect(row.span).toMatchObject({ days: 30 });
      expect((await visible()).map((i) => i.body)).toContain('Two approvals needed.');
    });

    it('refuses self-approval, repeat approval, and approval of a draft or decided revision', async () => {
      const { post, revision } = await service.createDraft(author, content('Separation of duties.'));
      await expect(service.approve(revision.id, admin1)).rejects.toMatchObject({ code: 'NETWORK_STATE_CONFLICT' });
      await service.submit(post.id, author);
      await expect(service.approve(revision.id, author)).rejects.toMatchObject({ code: 'NETWORK_SELF_APPROVAL' });
      await expect(service.reject(revision.id, author, 'spam_or_duplicate')).rejects.toMatchObject({ code: 'NETWORK_SELF_APPROVAL' });
      await service.approve(revision.id, admin1);
      await expect(service.approve(revision.id, admin1)).rejects.toMatchObject({ code: 'NETWORK_ALREADY_APPROVED' });
      await service.approve(revision.id, admin2);
      await expect(service.approve(revision.id, admin3)).rejects.toMatchObject({ code: 'NETWORK_STATE_CONFLICT' });
    });

    it('a rejection needs a listed reason, is recorded, and keeps the post off the feed', async () => {
      const { post, revision } = await service.createDraft(author, content('Please reject me.'));
      await service.submit(post.id, author);
      await expect(service.reject(revision.id, admin1, 'because')).rejects.toMatchObject({ code: 'NETWORK_REASON_INVALID' });
      const rejected = await service.reject(revision.id, admin1, 'misleading_claim');
      expect(rejected).toMatchObject({ status: 'rejected', reasonCode: 'misleading_claim' });
      expect((await visible()).map((i) => i.body)).not.toContain('Please reject me.');
    });

    it('only the author edits or submits; a stranger sees an indistinguishable not-found', async () => {
      const { post } = await service.createDraft(author, content('Mine.'));
      await expect(service.saveDraft(post.id, admin1, content('Stolen.'))).rejects.toMatchObject({ code: 'NETWORK_NOT_FOUND' });
      await expect(service.submit(post.id, admin1)).rejects.toMatchObject({ code: 'NETWORK_NOT_FOUND' });
    });

    it('an edit becomes a new reviewed revision; the old one stays live until the new one is approved', async () => {
      const { post } = await publish('Version one.');
      const draft = await service.saveDraft(post.id, author, content('Version two.'));
      expect(draft.revisionNo).toBe(2);
      expect((await visible()).map((i) => i.body)).toContain('Version one.');
      await service.submit(post.id, author);
      await service.approve(draft.id, admin1);
      expect((await visible()).map((i) => i.body)).toContain('Version one.');
      await service.approve(draft.id, admin3);
      const bodies = (await visible()).map((i) => i.body);
      expect(bodies).toContain('Version two.');
      expect(bodies).not.toContain('Version one.');
      const [old] = (await client.query("SELECT status FROM network_post_revisions WHERE post_id=$1 AND revision_no=1", [post.id])).rows;
      expect(old.status).toBe('superseded');
    });
  });

  describe('content rules', () => {
    it.each([
      ['markup', content('<b>bold</b>')],
      ['a mention', content('hello @everyone')],
      ['a hashtag', content('great #deal')],
      ['an email address', content('write to me@example.com')],
      ['a phone number', content('call 555 123 4567 now')],
      ['an http link', content('ok', { linkUrl: 'http://example.test/x' })],
      ['a credentialed link', content('ok', { linkUrl: 'https://user:pw@example.test/x' })],
      ['a javascript link', content('ok', { linkUrl: 'javascript:alert(1)' })],
      ['an unsupported language', content('ok', { contentLocale: 'xx' })],
      ['an empty body', content('   ')],
      ['a body over 2,000 characters', content('x'.repeat(2001))],
    ])('rejects %s before anything is stored', async (_label, input) => {
      await expect(service.createDraft(author, input)).rejects.toMatchObject({ code: 'NETWORK_CONTENT_INVALID' });
    });

    it('accepts exactly 2,000 characters and normalizes the link', async () => {
      const { revision } = await service.createDraft(author, content('é'.repeat(2000), { linkUrl: 'https://Example.com/a b' }));
      expect([...revision.body].length).toBe(2000);
      expect(revision.linkUrl).toBe('https://example.com/a%20b');
    });
  });

  describe('the database holds the line without the application', () => {
    const sqlFails = async (text: string, params: unknown[], pattern: RegExp) => {
      await expect(client.query(text, params)).rejects.toThrow(pattern);
    };

    it('cannot publish an unapproved or once-approved revision', async () => {
      const { post, revision } = await service.createDraft(author, content('Direct SQL attempt.'));
      await sqlFails("UPDATE network_posts SET state='published', live_revision_id=$2, published_at=now(), expires_at=now()+interval '30 days' WHERE id=$1",
        [post.id, revision.id], /approved revision/);
      await service.submit(post.id, author);
      await client.query("INSERT INTO network_revision_approvals(revision_id, approver_user_id) VALUES($1,$2)", [revision.id, admin1]);
      await client.query("UPDATE network_post_revisions SET status='approved', decided_at=now(), decided_by=$2 WHERE id=$1", [revision.id, admin1]);
      await sqlFails("UPDATE network_posts SET state='published', live_revision_id=$2, published_at=now(), expires_at=now()+interval '30 days' WHERE id=$1",
        [post.id, revision.id], /two distinct approvers/);
    });

    it('refuses an author approving their own revision and any change to an approval', async () => {
      const { post, revision } = await service.createDraft(author, content('Self approval via SQL.'));
      await service.submit(post.id, author);
      await sqlFails('INSERT INTO network_revision_approvals(revision_id, approver_user_id) VALUES($1,$2)', [revision.id, author], /own revision/);
      await client.query('INSERT INTO network_revision_approvals(revision_id, approver_user_id) VALUES($1,$2)', [revision.id, admin1]);
      await sqlFails('DELETE FROM network_revision_approvals WHERE revision_id=$1', [revision.id], /append-only/);
      await sqlFails("UPDATE network_revision_approvals SET approver_user_id=$2 WHERE revision_id=$1", [revision.id, admin2], /append-only/);
    });

    it('makes a submitted revision immutable, final states final, and forbids deletes', async () => {
      const { post, revisionId: revision } = await publish('Immutable once decided.');
      await sqlFails("UPDATE network_post_revisions SET body='tampered' WHERE id=$1", [revision], /immutable/);
      await sqlFails("UPDATE network_post_revisions SET status='draft' WHERE id=$1", [revision], /illegal network revision transition/);
      await sqlFails('DELETE FROM network_post_revisions WHERE id=$1', [revision], /never deleted/);
      await sqlFails('DELETE FROM network_posts WHERE id=$1', [post.id], /never deleted/);
      await sqlFails("UPDATE network_posts SET handle='AAAAAAAAAAAAAAAAAAAAAA' WHERE id=$1", [post.id], /identity is immutable/);
      await service.withdraw(post.id);
      await sqlFails("UPDATE network_posts SET state='published' WHERE id=$1", [post.id], /stays withdrawn/);
    });

    it('denies TRUNCATE on every network table, even for a replica-role session', async () => {
      for (const table of ['network_posts', 'network_post_revisions', 'network_revision_approvals']) {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        await expect(client.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/NETWORK_TRUNCATE_DENIED/);
        await client.query('ROLLBACK');
      }
    });

    it('the row guards also hold in a replica-role session (ENABLE ALWAYS)', async () => {
      const { post } = await service.createDraft(author, content('Replica role attempt.'));
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await expect(client.query("UPDATE network_posts SET handle='AAAAAAAAAAAAAAAAAAAAAA' WHERE id=$1", [post.id])).rejects.toThrow(/identity is immutable/);
      await client.query('ROLLBACK');
    });

    it('enforces plain text, https links, locale, digest format and the 2,000 limit at the table', async () => {
      const post = (await client.query("INSERT INTO network_posts(handle, author_user_id) VALUES($1,$2) RETURNING id", [`R${RUN}`.padEnd(22, 'x').slice(0, 22), author])).rows[0].id;
      const ins = (body: string, link: string | null, locale = 'en', digest = 'a'.repeat(64), no = 1) =>
        client.query('INSERT INTO network_post_revisions(post_id,revision_no,body,link_url,content_locale,content_digest,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [post, no, body, link, locale, digest, author]);
      await expect(ins('<i>x</i>', null)).rejects.toThrow(/network_rev_body_plain_text/);
      await expect(ins('x', 'http://x.test')).rejects.toThrow(/network_rev_link_https/);
      await expect(ins('x', null, 'zz')).rejects.toThrow(/network_rev_locale/);
      await expect(ins('x', null, 'en', 'nothex')).rejects.toThrow(/network_rev_digest_format/);
      await expect(ins('y'.repeat(2001), null)).rejects.toThrow(/network_rev_body_length/);
      await expect(client.query("INSERT INTO network_posts(handle, author_user_id, content_class) VALUES($1,$2,'business_post')", ['B'.repeat(22), author]))
        .rejects.toThrow(/network_posts_class_official_only/);
      await expect(client.query("INSERT INTO network_posts(handle, author_user_id, state) VALUES($1,$2,'published')", ['C'.repeat(22), author]))
        .rejects.toThrow(/starts unpublished/);
    });
  });

  describe('visibility, expiry, suspension and pinning', () => {
    it('hides suspended, withdrawn and expired posts and shows a lifted one again', async () => {
      const { post } = await publish('Visibility cycle.');
      expect((await visible()).map((i) => i.body)).toContain('Visibility cycle.');
      await service.suspend(post.id, admin1, 'spam_or_duplicate');
      expect((await visible()).map((i) => i.body)).not.toContain('Visibility cycle.');
      await service.lift(post.id);
      expect((await visible()).map((i) => i.body)).toContain('Visibility cycle.');
      await client.query("UPDATE network_posts SET published_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE id=$1", [post.id]);
      expect((await visible()).map((i) => i.body)).not.toContain('Visibility cycle.');
      await expect(service.pin(post.id)).rejects.toMatchObject({ code: 'NETWORK_STATE_CONFLICT' });
      const second = await publish('Withdrawn soon.');
      await service.withdraw(second.post.id);
      expect((await visible()).map((i) => i.body)).not.toContain('Withdrawn soon.');
    });

    it('allows exactly one pinned post, listed first; pinning another moves the pin', async () => {
      const a = await publish('Pin A.');
      const b = await publish('Pin B.');
      await service.pin(a.post.id);
      expect((await visible())[0]!.body).toBe('Pin A.');
      await service.pin(b.post.id);
      expect((await visible())[0]!.body).toBe('Pin B.');
      expect((await client.query("SELECT count(*)::int n FROM network_posts WHERE pinned")).rows[0].n).toBe(1);
      await expect(client.query("UPDATE network_posts SET pinned=true WHERE id=$1", [a.post.id])).rejects.toThrow(/network_posts_one_pinned_uq/);
      await service.withdraw(b.post.id);
      expect((await client.query("SELECT pinned FROM network_posts WHERE id=$1", [b.post.id])).rows[0].pinned).toBe(false);
    });

    it('pages with a stable keyset cursor, no repeats and no totals', async () => {
      await client.query("UPDATE network_posts SET state='withdrawn' WHERE state IN ('published','suspended')");
      const bodies = [];
      for (let i = 0; i < 5; i++) bodies.push((await publish(`Page ${i}`)).post);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 6; guard++) {
        const page = await feed.listVisible({ customerId: customer, cursor, limit: 2 });
        seen.push(...page.items.map((i) => i.body));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(seen[0]).toBe('Page 4');
      expect(await feed.listVisible({ customerId: customer, cursor: 'not-a-real-cursor', limit: 2 })).toEqual({ items: [], nextCursor: null });
      expect(bodies).toHaveLength(5);
    });

    it('exposes only the closed DTO: no internal ids, author, reviewers or moderation data', async () => {
      const [item] = await visible(1);
      expect(Object.keys(item!).sort()).toEqual(['body', 'businessName', 'contentClass', 'contentLocale', 'handle', 'linkUrl', 'publishedAt']);
      expect(item!.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(item!.businessName).toBeNull();
    });
  });

  describe('concurrency and isolation', () => {
    it('two simultaneous second approvals publish exactly once and never create a third state', async () => {
      const { post, revision } = await service.createDraft(author, content('Race to publish.'));
      await service.submit(post.id, author);
      await service.approve(revision.id, admin1);
      const racing = new NetworkPostService(buildDb(other));
      const results = await Promise.allSettled([service.approve(revision.id, admin2), racing.approve(revision.id, admin3)]);
      const published = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'published');
      expect(published).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const rows = (await client.query("SELECT state FROM network_posts WHERE id=$1", [post.id])).rows;
      expect(rows[0].state).toBe('published');
      expect((await client.query('SELECT count(*)::int n FROM network_revision_approvals WHERE revision_id=$1', [revision.id])).rows[0].n).toBeGreaterThanOrEqual(2);
    });

    it('a feed session and the whole lifecycle leave loyalty, membership and Community Points tables untouched', async () => {
      const before = await counts();
      await publish('Non-effect check.');
      await visible();
      expect(await counts()).toEqual(before);
    });
  });
});
