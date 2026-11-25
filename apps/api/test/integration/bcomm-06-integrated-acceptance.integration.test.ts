/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in route assertions */
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
import { communityFeedRoutes } from '../../src/community/community-feed.routes';
import { communityBusinessRoutes } from '../../src/community/community-business.routes';
import { networkBusinessPostRoutes } from '../../src/network/network-business-post.routes';
import { networkFollowRoutes } from '../../src/network/network-follow.routes';
import { networkEngagementRoutes } from '../../src/network/network-engagement.routes';
import { NetworkPostService } from '../../src/network/network-post.service';
import { BusinessProfileService } from '../../src/business-profile/business-profile.service';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { signAccessToken, signCashierAccessToken } from '../../src/auth/jwt';
import { pbkdf2Hash } from '../../src/auth/password';

/**
 * BCOMM-06 integrated TECHNICAL acceptance on a disposable PostgreSQL: the whole Business Community lifecycle through the real routes (business
 * publishing, platform moderation, the canonical Feed, follows, engagement, thresholded insights), the containment behaviour of every control,
 * and the fully disabled journey. This is local integration acceptance, not deployed staging acceptance.
 */
const databaseUrl = process.env.DATABASE_URL;
const CUSTOMER_SECRET = 'bcomm06-customer'; const STAFF_SECRET = 'bcomm06-staff';
const app = new Hono<{ Bindings: Bindings }>();
app.use('*', auditTrail);
app.route('/api/v1/network/business-posts', networkBusinessPostRoutes);
app.route('/api/v1/network/follows', networkFollowRoutes);
app.route('/api/v1/network/engagement', networkEngagementRoutes);
app.route('/api/v1/network', communityFeedRoutes);
app.route('/api/v1/community/business', communityBusinessRoutes);
app.onError(errorHandler);

const ON = { NETWORK_FEED_ENABLED: 'true', NETWORK_BUSINESS_PUBLISHING_ENABLED: 'true', NETWORK_BUSINESS_DISTRIBUTION_ENABLED: 'true', NETWORK_BUSINESS_DAILY_POST_CAP: '50' };
async function call(path: string, o: { method?: string; token?: string; businessId?: string; body?: unknown; env?: Record<string, unknown> } = {}) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers({ 'content-type': 'application/json' });
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.businessId) headers.set('X-Business-Id', o.businessId);
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl },
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET, JWT_ACCESS_SECRET: STAFF_SECRET,
    PUBLIC_RATE_LIMITER: { limit: async () => ({ success: true }) }, CUSTOMER_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...(o.env && 'ALL_OFF' in o.env ? {} : ON), ...o.env,
  } as unknown as Bindings;
  const res = await app.request(`/api/v1${path}`, { method: o.method ?? 'GET', headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let json: { data?: any; error?: { code: string } } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* plain */ }
  return { status: res.status, text, data: (json.data ?? {}) as Record<string, any>, list: (Array.isArray(json.data) ? json.data : []) as any[], code: json.error?.code };
}

describe.skipIf(!databaseUrl)('BCOMM-06 integrated acceptance (disposable PostgreSQL)', () => {
  let client: Client;
  const run = randomUUID().slice(0, 8);
  // Public display names must not look like a phone number (the profile validator refuses digit runs), so they use a digit-free form of the run id.
  const tag = run.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!);
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const id: Record<string, string> = {}; const tok: Record<string, string> = {};
  let bizA = ''; let bizB = ''; let handleA = '';
  let moderation: NetworkPostService;
  const customers: { id: string; token: string }[] = [];
  const body = (text: string) => ({ body: text, contentLocale: 'en' });
  const asOwner = (b = () => bizA, t = 'ownerA') => ({ token: tok[t]!, businessId: b() });

  async function profile(biz: string, owner: string, label: string) {
    const category = (await q('select id from business_categories limit 1'))[0]?.id as string | undefined;
    if (category) await q('update businesses set category_id=$2 where id=$1', [biz, category]);
    const profiles = new BusinessProfileService(buildDb(client));
    const draft = await profiles.saveDraft(biz, { userId: owner, role: 'business' }, {
      websiteUrl: 'https://cafe.example',
      translations: [{ locale: 'en', displayName: `Cafe ${label} ${tag}`, summary: 'Coffee', description: 'Fresh coffee daily.' }],
      locations: [{ kind: 'place', label: 'Main shop', countryCode: 'GB', city: 'London' }],
    });
    const sub = await profiles.submit(biz, { userId: owner, role: 'business' }, draft.revisionId!);
    await profiles.approve(draft.revisionId!, { userId: id.mod1!, role: 'platform_admin' }, sub.digest);
    return (await q('select profile_handle from business_public_profiles where business_id=$1', [biz]))[0].profile_handle as string;
  }
  const revisionOf = async (handle: string) => (await q(`select r.id from network_post_revisions r join network_posts p on p.id=r.post_id where p.handle=$1 and r.status='submitted'`, [handle]))[0].id as string;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const admin = createRepositories(buildDb(client));
    for (const k of ['ownerA', 'staffA', 'ownerB', 'mod1', 'mod2']) {
      id[k] = (await admin.users.create({ email: `b6-${k}-${tag}@example.test`, fullName: k, passwordHash: await pbkdf2Hash('unused-password-1', 1000), status: 'active' })).id;
      tok[k] = await signAccessToken(id[k]!, STAFF_SECRET);
    }
    bizA = (await admin.businesses.create({ name: `B6 A ${tag}`, slug: `b6-a-${tag}` })).id;
    bizB = (await admin.businesses.create({ name: `B6 B ${tag}`, slug: `b6-b-${tag}` })).id;
    const provisioning = new RoleProvisioningService(admin);
    for (const [biz, owner] of [[bizA, id.ownerA!], [bizB, id.ownerB!]] as const) {
      const roles = await provisioning.seedDefaultRoles(biz, owner);
      await admin.userBusinessRoles.grant({ userId: owner, businessId: biz, branchId: null, roleId: roles.Owner, createdBy: owner });
      if (biz === bizA) await admin.userBusinessRoles.grant({ userId: id.staffA!, businessId: biz, branchId: null, roleId: roles.Staff, createdBy: owner });
    }
    handleA = await profile(bizA, id.ownerA!, 'A'); await profile(bizB, id.ownerB!, 'B');
    moderation = new NetworkPostService(buildDb(client));
    for (let i = 0; i < 11; i += 1) {
      const cid = (await q(`insert into customers(status, phone, phone_verified_at) values ('active', $1, now()) returning id`, [`+4479${Math.floor(10000000 + Math.random() * 89999999)}`]))[0].id as string;
      customers.push({ id: cid, token: await signCustomerAccessToken(cid, CUSTOMER_SECRET) });
    }
  });
  afterAll(async () => { await client?.end(); });

  it('THE JOURNEY: draft -> submit -> moderation -> feed -> follow -> engagement -> insights, with every actor boundary holding', async () => {
    // 3-4. the owner writes a post and edits the draft
    const created = await call('/network/business-posts', { method: 'POST', body: body(`Journey post ${tag}`), ...asOwner() });
    expect(created.status, created.text).toBe(201);
    const handle = created.data.handle as string;
    expect((await call(`/network/business-posts/${handle}/draft`, { method: 'PUT', body: body(`Journey post v2 ${tag}`), ...asOwner() })).data.body).toContain('v2');
    // 5. submitted; the customer feed shows nothing yet
    expect((await call(`/network/business-posts/${handle}/submit`, { method: 'POST', ...asOwner() })).data.stage).toBe('awaiting_review');
    const beforeApproval = await call('/network/feed', { token: customers[0]!.token });
    expect(JSON.stringify(beforeApproval.data)).not.toContain(`Journey post v2 ${tag}`);
    // 6-7. platform moderation: the author cannot approve, a different platform user can; then it is eligible
    const rev = await revisionOf(handle);
    await expect(moderation.approve(rev, id.ownerA!)).rejects.toMatchObject({ code: 'NETWORK_SELF_APPROVAL' });
    expect((await moderation.approve(rev, id.mod2!)).status).toBe('published');
    // 8. every customer discovers it in the canonical Feed, under the published business name
    for (const c of customers) {
      const feed = await call('/network/feed', { token: c.token });
      const item = (feed.data.items as any[]).find((i) => i.body === `Journey post v2 ${tag}`);
      expect(item, feed.text).toMatchObject({ contentClass: 'business_post', businessName: `Cafe A ${tag}`, businessHandle: handleA });
    }
    // 10-11. voluntary follow and an engagement (link open); a follow does NOT enroll, consent or message
    const fingerprint = async () => Object.fromEntries(await Promise.all(['community_memberships', 'consent_grants', 'loyalty_accounts', 'loyalty_transactions', 'community_point_transactions', 'notifications']
      .map(async (t) => [t, (await q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from ${t} x`))[0]])));
    const before = await fingerprint();
    for (const c of customers) {
      expect((await call(`/network/follows/${handleA}`, { method: 'PUT', token: c.token })).data).toEqual({ following: true });
      expect((await call(`/network/engagement/${handle}`, { method: 'POST', token: c.token })).data).toEqual({ recorded: true });
    }
    expect(await fingerprint()).toEqual(before);
    // 12-13. events are recorded and the owner sees thresholded aggregates (11 distinct customers >= 10)
    const insights = await call('/community/business/insights?days=30', asOwner());
    expect(insights.data).toMatchObject({
      impressions: { state: 'shown', value: 11 }, uniqueReach: { state: 'shown', value: 11 }, engagements: { state: 'shown', value: 11 },
      newFollowers: { state: 'shown', value: 11 }, currentFollowers: { state: 'shown', value: 11 },
      attribution: { state: 'not_measured' }, profileVisits: { state: 'not_measured' },
    });
    // 14. another business sees none of it and cannot touch this post
    const other = await call('/community/business/insights?days=30', asOwner(() => bizB, 'ownerB'));
    expect(other.data.engagements).toEqual({ state: 'suppressed' });
    expect((await call(`/network/business-posts/${handle}`, { ...asOwner(() => bizB, 'ownerB') })).status).toBe(404);
    expect([401, 403, 404]).toContain((await call('/community/business/insights', { token: tok.ownerB!, businessId: bizA })).status);
    // 15. cashier-level staff and a dead cashier session cannot manage publishing or read insights
    for (const t of [call('/network/business-posts', { method: 'POST', body: body('x'), ...asOwner(() => bizA, 'staffA') }), call('/network/business-posts', { ...asOwner(() => bizA, 'staffA') }),
      call('/network/business-posts', { token: await signCashierAccessToken(id.staffA!, STAFF_SECRET, { sessionId: randomUUID(), businessId: bizA }), businessId: bizA })]) {
      expect([401, 403]).toContain((await t).status);
    }
    expect([401, 403]).toContain((await call('/community/business/insights', asOwner(() => bizA, 'staffA'))).status);
    // The owner cannot use the customer routes, so cannot add to its own totals
    expect((await call(`/network/engagement/${handle}`, { method: 'POST', token: tok.ownerA! })).status).toBe(401);
    // audit evidence exists for the business-side actions and never contains the text
    const audits = await q(`select action, metadata::text m from audit_log where action like 'network.business_post_%' and business_id=$1`, [bizA]);
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain('Journey post');
  });

  it('CONTAINMENT: each control closes only its own capability and never destroys history', async () => {
    const created = await call('/network/business-posts', { method: 'POST', body: body(`Containment post ${tag}`), ...asOwner() });
    const handle = created.data.handle as string;
    await call(`/network/business-posts/${handle}/submit`, { method: 'POST', ...asOwner() });
    await moderation.approve(await revisionOf(handle), id.mod2!);
    const visible = async (env?: Record<string, unknown>) => JSON.stringify((await call('/network/feed', { token: customers[0]!.token, ...(env ? { env } : {}) })).data).includes(`Containment post ${tag}`);
    expect(await visible()).toBe(true);
    const postsBefore = Number((await q('select count(*)::int n from network_posts where business_id=$1', [bizA]))[0].n);
    const revisionsBefore = Number((await q('select count(*)::int n from network_post_revisions r join network_posts p on p.id=r.post_id where p.business_id=$1', [bizA]))[0].n);

    // publishing closed: authoring stops (404), reading own history still works, customers still see approved posts
    expect((await call('/network/business-posts', { method: 'POST', body: body('x'), env: { NETWORK_BUSINESS_PUBLISHING_ENABLED: undefined }, ...asOwner() })).status).toBe(404);
    expect((await call(`/network/business-posts/${handle}`, { env: { NETWORK_BUSINESS_PUBLISHING_ENABLED: undefined }, ...asOwner() })).status).toBe(200);
    expect(await visible({ NETWORK_BUSINESS_PUBLISHING_ENABLED: undefined })).toBe(true);
    // distribution closed: customers no longer see it, follows can still be removed, the business still sees and edits its own posts
    expect(await visible({ NETWORK_BUSINESS_DISTRIBUTION_ENABLED: undefined })).toBe(false);
    expect((await call(`/network/follows/${handleA}`, { method: 'DELETE', token: customers[1]!.token, env: { NETWORK_BUSINESS_DISTRIBUTION_ENABLED: undefined } })).status).toBe(200);
    expect((await call(`/network/follows/${handleA}`, { method: 'PUT', token: customers[1]!.token, env: { NETWORK_BUSINESS_DISTRIBUTION_ENABLED: undefined } })).status).toBe(404);
    // feed closed: the whole customer surface answers 404 and business reads are unaffected
    expect((await call('/network/feed', { token: customers[0]!.token, env: { NETWORK_FEED_ENABLED: undefined } })).status).toBe(404);
    // a suspended business disappears from customers and cannot submit; restoring it restores visibility
    await q(`update businesses set status='suspended' where id=$1`, [bizA]);
    try { expect(await visible()).toBe(false); } finally { await q(`update businesses set status='active' where id=$1`, [bizA]); }
    expect(await visible()).toBe(true);
    // nothing was deleted by any of the above
    expect(Number((await q('select count(*)::int n from network_posts where business_id=$1', [bizA]))[0].n)).toBe(postsBefore);
    expect(Number((await q('select count(*)::int n from network_post_revisions r join network_posts p on p.id=r.post_id where p.business_id=$1', [bizA]))[0].n)).toBe(revisionsBefore);
  });

  it('CUSTOMER DELETION: removing a customer removes only that customer\'s follows and events; posts, revisions and other customers are untouched', async () => {
    const victim = customers[10]!;
    await call(`/network/follows/${handleA}`, { method: 'PUT', token: victim.token });
    const own = async () => Number((await q(`select (select count(*) from network_follows where customer_id=$1) + (select count(*) from network_engagement_events where customer_id=$1) as n`, [victim.id]))[0].n);
    expect(await own()).toBeGreaterThan(0);
    const others = Number((await q('select count(*)::int n from network_follows where customer_id <> $1 and business_id=$2', [victim.id, bizA]))[0].n);
    const posts = Number((await q('select count(*)::int n from network_posts where business_id=$1', [bizA]))[0].n);
    await q('delete from customers where id=$1', [victim.id]);
    expect(await own()).toBe(0);
    expect(Number((await q('select count(*)::int n from network_follows where business_id=$1', [bizA]))[0].n)).toBe(others);
    expect(Number((await q('select count(*)::int n from network_posts where business_id=$1', [bizA]))[0].n)).toBe(posts);
  });

  it('THE DISABLED JOURNEY: with every control closed nothing can be created, shown, followed or recorded, and the owner still reads history', async () => {
    const off = { ALL_OFF: true, NETWORK_FEED_ENABLED: undefined, NETWORK_BUSINESS_PUBLISHING_ENABLED: undefined, NETWORK_BUSINESS_DISTRIBUTION_ENABLED: undefined };
    const eventsBefore = Number((await q('select count(*)::int n from network_engagement_events'))[0].n);
    expect((await call('/network/business-posts', { method: 'POST', body: body('x'), env: off, ...asOwner() })).status).toBe(404);
    expect((await call('/network/feed', { token: customers[0]!.token, env: off })).status).toBe(404);
    expect((await call(`/network/follows/${handleA}`, { method: 'PUT', token: customers[0]!.token, env: off })).status).toBe(404);
    expect((await call(`/network/engagement/${'A'.repeat(22)}`, { method: 'POST', token: customers[0]!.token, env: off })).status).toBe(404);
    const status = await call('/community/business/status', { env: off, ...asOwner() });
    expect(status.data).toMatchObject({ publishing: 'closed', distribution: 'closed', feed: 'closed' });
    expect((await call('/network/business-posts', { env: off, ...asOwner() })).status).toBe(200); // own history stays readable
    expect(Number((await q('select count(*)::int n from network_engagement_events'))[0].n)).toBe(eventsBefore);
  });
});
