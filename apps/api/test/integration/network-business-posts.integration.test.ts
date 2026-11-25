import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { networkBusinessPostRoutes } from '../../src/network/network-business-post.routes';
import { NetworkPostService } from '../../src/network/network-post.service';
import { BusinessProfileService } from '../../src/business-profile/business-profile.service';
import { signAccessToken, signImpersonationToken } from '../../src/auth/jwt';
import { pbkdf2Hash } from '../../src/auth/password';

/**
 * BCOMM-03 against real PostgreSQL (migration 0091): business post authoring through the real route, tenant resolution and RBAC, then the
 * platform moderation service for the decision. Covers the lifecycle, one-approver publication, self-approval, cross-tenant isolation, the
 * publishing control, impersonation, the daily cap, direct-SQL bypass attempts and non-effect on every loyalty / points table.
 */
const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'network-business-posts-secret';
const app = new Hono<{ Bindings: Bindings }>();
app.use('*', auditTrail);
app.route('/api/v1/network/business-posts', networkBusinessPostRoutes);
app.onError(errorHandler);

type Call = { method?: string; path?: string; token?: string; businessId?: string; body?: unknown; env?: Record<string, unknown> };
async function call(c: Call) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers({ 'content-type': 'application/json' });
  if (c.token) headers.set('Authorization', `Bearer ${c.token}`);
  if (c.businessId) headers.set('X-Business-Id', c.businessId);
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl },
    JWT_ACCESS_SECRET: SECRET,
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    NETWORK_BUSINESS_PUBLISHING_ENABLED: 'true',
    NETWORK_BUSINESS_DAILY_POST_CAP: '60', // the cap itself is exercised in its own test on a business of its own
    ...c.env,
  } as unknown as Bindings;
  const res = await app.request(`/api/v1/network/business-posts${c.path ?? ''}`,
    { method: c.method ?? 'GET', headers, ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}) }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  type PostData = { handle: string; body: string; stage: string; latestStatus: string; latestRevisionNo: number; reasonCode: string | null; state: string };
  let json: { data?: PostData; error?: { code: string } } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* plain text */ }
  return { status: res.status, text, cache: res.headers.get('cache-control'), data: (json.data ?? {}) as PostData, code: json.error?.code };
}

describe.skipIf(!databaseUrl)('business posts (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  const run = randomUUID().slice(0, 8);
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  let bizA = ''; let bizB = ''; let bizC = '';
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  let moderation: NetworkPostService;
  const body = (text = 'We open a second counter this Saturday.') => ({ body: text, contentLocale: 'en' });

  async function publishProfile(biz: string, owner: string, reviewer: string) {
    const profiles = new BusinessProfileService(buildDb(client));
    const catalog = (await q('select id from business_categories limit 1'))[0]?.id as string | undefined;
    if (catalog) await q('update businesses set category_id=$2 where id=$1', [biz, catalog]);
    const draft = await profiles.saveDraft(biz, { userId: owner, role: 'business' }, {
      websiteUrl: 'https://cafe.example',
      translations: [{ locale: 'en', displayName: `Cafe ${run}`, summary: 'Coffee', description: 'Fresh coffee daily.' }],
      locations: [{ kind: 'place', label: 'Main shop', countryCode: 'GB', city: 'London' }],
    });
    const sub = await profiles.submit(biz, { userId: owner, role: 'business' }, draft.revisionId!);
    await profiles.approve(draft.revisionId!, { userId: reviewer, role: 'platform_admin' }, sub.digest);
  }

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const admin = createRepositories(buildDb(client));
    const user = async (label: string) => (await admin.users.create({
      email: `bp3-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash('unused-password-1', 1000), status: 'active',
    })).id;
    for (const k of ['ownerA', 'managerA', 'staffA', 'ownerB', 'ownerC', 'mod1', 'mod2', 'outsider']) id[k] = await user(k);
    bizA = (await admin.businesses.create({ name: 'Post A', slug: `bp3-a-${run}` })).id;
    bizB = (await admin.businesses.create({ name: 'Post B', slug: `bp3-b-${run}` })).id;
    bizC = (await admin.businesses.create({ name: 'Post C (no profile)', slug: `bp3-c-${run}` })).id;
    const provisioning = new RoleProvisioningService(admin);
    for (const [biz, owner] of [[bizA, id.ownerA!], [bizB, id.ownerB!], [bizC, id.ownerC!]] as const) {
      const roles = await provisioning.seedDefaultRoles(biz, owner);
      await admin.userBusinessRoles.grant({ userId: owner, businessId: biz, branchId: null, roleId: roles.Owner, createdBy: owner });
      if (biz === bizA) {
        await admin.userBusinessRoles.grant({ userId: id.managerA!, businessId: biz, branchId: null, roleId: roles.Manager, createdBy: owner });
        await admin.userBusinessRoles.grant({ userId: id.staffA!, businessId: biz, branchId: null, roleId: roles.Staff, createdBy: owner });
      }
    }
    for (const [k, v] of Object.entries(id)) tok[k] = await signAccessToken(v, SECRET);
    await publishProfile(bizA, id.ownerA!, id.mod1!);
    await publishProfile(bizB, id.ownerB!, id.mod1!);
    moderation = new NetworkPostService(buildDb(client));
  });
  afterAll(async () => { await client?.end(); });

  const own = (t = 'ownerA', b = () => bizA) => ({ token: tok[t]!, businessId: b() });

  it('draft -> preview -> submit -> ONE platform approver publishes it under the business; the author cannot approve; history stays', async () => {
    const created = await call({ method: 'POST', body: body(), ...own() });
    expect(created.status, created.text).toBe(201);
    expect(created.cache).toBeNull();
    const handle = created.data.handle as string;
    expect(created.data).toMatchObject({ stage: 'draft', latestStatus: 'draft', body: body().body });

    const edited = await call({ method: 'PUT', path: `/${handle}/draft`, body: body('We open a second counter this Sunday.'), ...own() });
    expect(edited.data.body).toContain('Sunday');
    expect((await call({ path: `/${handle}`, ...own() })).data.body).toContain('Sunday'); // preview of the draft

    const submitted = await call({ method: 'POST', path: `/${handle}/submit`, ...own() });
    expect(submitted.data.stage).toBe('awaiting_review');
    expect((await call({ method: 'PUT', path: `/${handle}/draft`, body: body('Late edit'), ...own() })).status).toBe(409);

    const revisionId = (await q(`select r.id from network_post_revisions r join network_posts p on p.id=r.post_id where p.handle=$1 and r.status='submitted'`, [handle]))[0].id as string;
    await expect(moderation.approve(revisionId, id.ownerA!)).rejects.toMatchObject({ code: 'NETWORK_SELF_APPROVAL' });
    const decided = await moderation.approve(revisionId, id.mod2!);
    expect(decided.status).toBe('published'); // exactly one approver for a business post
    const live = await call({ path: `/${handle}`, ...own() });
    expect(live.data).toMatchObject({ stage: 'live', state: 'published', latestStatus: 'approved' });
    const row = (await q(`select content_class, business_id, author_user_id from network_posts where handle=$1`, [handle]))[0];
    expect(row).toMatchObject({ content_class: 'business', business_id: bizA, author_user_id: id.ownerA });

    // Re-editing a live post opens revision 2 without removing the live revision.
    const second = await call({ method: 'PUT', path: `/${handle}/draft`, body: body('Updated opening hours.'), ...own() });
    expect(second.data).toMatchObject({ latestRevisionNo: 2, stage: 'live' });
    expect((await q(`select state from network_posts where handle=$1`, [handle]))[0].state).toBe('published');

    const archived = await call({ method: 'POST', path: `/${handle}/archive`, ...own() });
    expect(archived.data).toMatchObject({ stage: 'archived', state: 'withdrawn' });
    expect((await call({ method: 'PUT', path: `/${handle}/draft`, body: body('x'), ...own() })).status).toBe(409);
    // Archiving never deletes: every revision is still there.
    expect(Number((await q(`select count(*)::int n from network_post_revisions r join network_posts p on p.id=r.post_id where p.handle=$1`, [handle]))[0].n)).toBe(2);
  });

  it('a rejected revision shows its moderator reason code; the business can fix and resubmit', async () => {
    const created = await call({ method: 'POST', body: body('Special offer on all drinks.'), ...own() });
    const handle = created.data.handle as string;
    await call({ method: 'POST', path: `/${handle}/submit`, ...own() });
    const revisionId = (await q(`select r.id from network_post_revisions r join network_posts p on p.id=r.post_id where p.handle=$1 and r.status='submitted'`, [handle]))[0].id as string;
    await moderation.reject(revisionId, id.mod1!, 'misleading_claim');
    const view = await call({ path: `/${handle}`, ...own() });
    expect(view.data).toMatchObject({ stage: 'rejected', reasonCode: 'misleading_claim' });
    const fixed = await call({ method: 'PUT', path: `/${handle}/draft`, body: body('Two coffees for the price of one on Friday.'), ...own() });
    expect(fixed.data).toMatchObject({ latestRevisionNo: 2, stage: 'draft', reasonCode: null });
    expect((await call({ method: 'POST', path: `/${handle}/submit`, ...own() })).data.stage).toBe('awaiting_review');
  });

  it('content rules: plain text only, no markup, no personal data, https links only', async () => {
    for (const bad of [
      { ...body('<b>hi</b>') }, { ...body('Call +44 20 7946 0958 now') }, { ...body('Mail us a@b.co') }, { ...body('#sale today') },
      { ...body('ok'), linkUrl: 'http://insecure.example' }, { ...body(''), contentLocale: 'en' }, { body: 'x', contentLocale: 'de' },
    ]) {
      const res = await call({ method: 'POST', body: bad, ...own() });
      expect([400, 422], JSON.stringify(bad)).toContain(res.status);
    }
  });

  it('a post may link only to the business\'s own published website (or its subdomains); lookalike hosts and a business with no published profile cannot link', async () => {
    for (const ok of ['https://cafe.example/menu', 'https://www.cafe.example', 'https://shop.cafe.example/x?y=1']) {
      expect((await call({ method: 'POST', body: { ...body('Link check'), linkUrl: ok }, ...own() })).status, ok).toBe(201);
    }
    for (const bad of ['https://evil.example', 'https://cafe.example.evil.example', 'https://notcafe.example', 'https://cafe.example@evil.example']) {
      const res = await call({ method: 'POST', body: { ...body('Link check'), linkUrl: bad }, ...own() });
      expect([422], `${bad}: ${res.text}`).toContain(res.status);
    }
    const edit = await call({ method: 'POST', body: body('Edit target'), ...own() });
    const refused = await call({ method: 'PUT', path: `/${edit.data.handle}/draft`, body: { ...body('Edit target'), linkUrl: 'https://evil.example' }, ...own() });
    expect(refused.status).toBe(422);
    expect(refused.code).toBe('NETWORK_LINK_DOMAIN');
    expect([409, 422]).toContain((await call({ method: 'POST', body: { ...body('No profile'), linkUrl: 'https://cafe.example' }, ...own('ownerC', () => bizC) })).status); // no profile at all: never created
  });

  it('submission needs a published profile and an active business; a business without a profile cannot even draft', async () => {
    const noProfile = await call({ method: 'POST', body: body(), ...own('ownerC', () => bizC) });
    expect(noProfile.status, noProfile.text).toBe(409);
    expect(noProfile.code).toBe('NETWORK_PROFILE_REQUIRED');
    const created = await call({ method: 'POST', body: body('Hello from A'), ...own() });
    await q(`update businesses set status='suspended' where id=$1`, [bizA]);
    try {
      const refused = await call({ method: 'POST', path: `/${created.data.handle}/submit`, ...own() });
      expect([403, 409], refused.text).toContain(refused.status); // refused at tenant resolution or by the service, never submitted
      expect((await q(`select r.status from network_post_revisions r join network_posts p on p.id=r.post_id where p.handle=$1`, [created.data.handle]))[0].status).toBe('draft');
    } finally {
      await q(`update businesses set status='active' where id=$1`, [bizA]);
    }
  });

  it('the database refuses to publish a business post when the profile is unpublished or the business suspended, and to publish with no approver (direct SQL)', async () => {
    const submitNew = async (text: string) => {
      const created = await call({ method: 'POST', body: body(text), ...own() });
      const handle = created.data.handle as string;
      await call({ method: 'POST', path: `/${handle}/submit`, ...own() });
      const post = (await q('select id from network_posts where handle=$1', [handle]))[0].id as string;
      const rev = (await q(`select id from network_post_revisions where post_id=$1 and status='submitted'`, [post]))[0].id as string;
      return { post, rev };
    };
    const live = (post: string, rev: string) => q(`update network_posts set state='published', live_revision_id=$2, published_at=now(), expires_at=now()+interval '1 day' where id=$1`, [post, rev]);
    // 1. Approved revision with NO recorded approver: going live is refused.
    const a = await submitNew('Direct SQL probe one');
    await q(`update network_post_revisions set status='approved', decided_at=now(), decided_by=$2 where id=$1`, [a.rev, id.mod2]);
    await expect(live(a.post, a.rev)).rejects.toThrow(/one distinct platform approver/);
    // 2. One real approver but the business suspended: refused; with the business active again it is allowed (one approver suffices).
    const b = await submitNew('Direct SQL probe two');
    await q('insert into network_revision_approvals(revision_id, approver_user_id) values ($1,$2)', [b.rev, id.mod2]);
    await q(`update network_post_revisions set status='approved', decided_at=now(), decided_by=$2 where id=$1`, [b.rev, id.mod2]);
    await q(`update businesses set status='suspended' where id=$1`, [bizA]);
    try {
      await expect(live(b.post, b.rev)).rejects.toThrow(/published profile and an active business/);
    } finally {
      await q(`update businesses set status='active' where id=$1`, [bizA]);
    }
    await expect(live(b.post, b.rev)).resolves.toBeDefined();
    const post = b.post;
    await expect(q(`update network_posts set business_id=$2 where id=$1`, [post, bizB])).rejects.toThrow(/identity is immutable/);
    await expect(q(`insert into network_posts(handle, content_class, author_user_id) values ('${'A'.repeat(22)}', 'business', $1)`, [id.ownerA])).rejects.toThrow(/business_scope/);
  });

  it('cross-tenant: another business can neither read nor change this business\'s posts, with the same generic 404', async () => {
    const mine = await call({ method: 'POST', body: body('Private to A'), ...own() });
    const handle = mine.data.handle as string;
    for (const attempt of [
      call({ path: `/${handle}`, ...own('ownerB', () => bizB) }),
      call({ method: 'PUT', path: `/${handle}/draft`, body: body('hijack'), ...own('ownerB', () => bizB) }),
      call({ method: 'POST', path: `/${handle}/submit`, ...own('ownerB', () => bizB) }),
      call({ method: 'POST', path: `/${handle}/archive`, ...own('ownerB', () => bizB) }),
    ]) expect((await attempt).status).toBe(404);
    const listB = await call({ ...own('ownerB', () => bizB) });
    expect(JSON.stringify(listB.data)).not.toContain('Private to A');
    // B owner naming A's business is refused by tenant resolution.
    expect([401, 403, 404]).toContain((await call({ token: tok.ownerB!, businessId: bizA })).status);
  });

  it('authorization: a manager, cashier-level staff, an outsider and an anonymous caller cannot manage posts (server-side)', async () => {
    for (const who of ['managerA', 'staffA', 'outsider']) {
      expect([401, 403], who).toContain((await call({ ...own(who) })).status);
      expect([401, 403], who).toContain((await call({ method: 'POST', body: body(), ...own(who) })).status);
    }
    expect([401, 403]).toContain((await call({ businessId: bizA })).status);
    // The business role can never moderate: a business user has no path to the platform service, and cannot approve via the business routes.
    expect((await call({ method: 'POST', path: '/approve', ...own() })).status).toBeGreaterThanOrEqual(400);
  });

  it('the publishing control fails closed: every write answers 404 when it is not exactly "true", reads of own history still work', async () => {
    const created = await call({ method: 'POST', body: body('Before the control closes'), ...own() });
    const handle = created.data.handle as string;
    for (const value of [undefined, 'false', 'TRUE', '1', 'yes', '', true]) {
      const env = { NETWORK_BUSINESS_PUBLISHING_ENABLED: value };
      expect((await call({ method: 'POST', body: body('x'), env, ...own() })).status, String(value)).toBe(404);
      expect((await call({ method: 'PUT', path: `/${handle}/draft`, body: body('x'), env, ...own() })).status).toBe(404);
      expect((await call({ method: 'POST', path: `/${handle}/submit`, env, ...own() })).status).toBe(404);
      expect((await call({ method: 'POST', path: `/${handle}/archive`, env, ...own() })).status).toBe(404);
      const read = await call({ path: `/${handle}`, env, ...own() });
      expect(read.status).toBe(200); // history stays readable
    }
  });

  it('an impersonation session can read but never author', async () => {
    const imp = (await signImpersonationToken(id.ownerA!, id.mod1!, SECRET)).token;
    const readImp = await call({ token: imp, businessId: bizA, env: { PLATFORM_IMPERSONATION_ENABLED: 'true' } });
    expect(readImp.status, readImp.text).toBe(200);
    const write = await call({ method: 'POST', body: body(), token: imp, businessId: bizA, env: { PLATFORM_IMPERSONATION_ENABLED: 'true' } });
    expect(write.status).toBe(403);
    expect(write.code).toBe('IMPERSONATION_READ_ONLY');
  });

  it('the daily cap bounds a business and is race-safe', async () => {
    const before = Number((await q(`select count(*)::int n from network_posts where business_id=$1 and created_at > now() - interval '24 hours'`, [bizB]))[0].n);
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) => call({ method: 'POST', body: body(`Cap probe ${i}`), env: { NETWORK_BUSINESS_DAILY_POST_CAP: '5' }, ...own('ownerB', () => bizB) })));
    const created = attempts.filter((r) => r.status === 201).length;
    expect(created).toBe(Math.max(0, 5 - before));
    expect(attempts.filter((r) => r.status === 429).every((r) => r.code === 'NETWORK_DAILY_CAP')).toBe(true);
  });

  it('writes audit evidence without post text, and never touches loyalty, points, consent or customer data', async () => {
    const tables = ['community_memberships', 'community_point_accounts', 'community_point_transactions', 'consent_grants', 'customers', 'loyalty_accounts', 'loyalty_transactions'];
    const fingerprint = async () => Object.fromEntries(await Promise.all(tables.map(async (t) =>
      [t, (await q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from ${t} x`))[0]])));
    const before = await fingerprint();
    const c = await call({ method: 'POST', body: body('Audit probe text'), ...own() });
    await call({ method: 'POST', path: `/${c.data.handle}/submit`, ...own() });
    expect(await fingerprint()).toEqual(before);
    const postId = (await q('select id from network_posts where handle=$1', [c.data.handle]))[0].id as string;
    const audits = await q(`select action, metadata::text d from audit_log where entity_id=$1 order by created_at`, [postId]);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['network.business_post_draft_created', 'network.business_post_submitted']));
    expect(JSON.stringify(audits)).not.toContain('Audit probe text');
  });
});
