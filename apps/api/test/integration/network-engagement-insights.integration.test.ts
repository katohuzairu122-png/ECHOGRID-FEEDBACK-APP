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
import { communityFeedRoutes } from '../../src/community/community-feed.routes';
import { communityBusinessRoutes } from '../../src/community/community-business.routes';
import { networkFollowRoutes } from '../../src/network/network-follow.routes';
import { networkEngagementRoutes } from '../../src/network/network-engagement.routes';
import { NetworkPostService } from '../../src/network/network-post.service';
import { NetworkBusinessPostService } from '../../src/network/network-business-post.service';
import { BusinessProfileService } from '../../src/business-profile/business-profile.service';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { signAccessToken } from '../../src/auth/jwt';
import { pbkdf2Hash } from '../../src/auth/password';

/**
 * BCOMM-05 against real PostgreSQL (migration 0093): server-recorded engagement events, their idempotency and tenant scoping, and the
 * thresholded insights route. Business users cannot write events; small audiences are never disclosed; nothing touches membership, consent,
 * points or loyalty data.
 */
const databaseUrl = process.env.DATABASE_URL;
const CUSTOMER_SECRET = 'insights-customer-secret';
const STAFF_SECRET = 'insights-staff-secret';
const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/network/follows', networkFollowRoutes);
app.route('/api/v1/network/engagement', networkEngagementRoutes);
app.route('/api/v1/network', communityFeedRoutes);
app.route('/api/v1/community/business', communityBusinessRoutes);
app.onError(errorHandler);

async function call(path: string, o: { method?: string; token?: string; businessId?: string; env?: Record<string, unknown> } = {}) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.businessId) headers.set('X-Business-Id', o.businessId);
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl },
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET, JWT_ACCESS_SECRET: STAFF_SECRET,
    NETWORK_FEED_ENABLED: 'true', NETWORK_BUSINESS_DISTRIBUTION_ENABLED: 'true',
    PUBLIC_RATE_LIMITER: { limit: async () => ({ success: true }) }, CUSTOMER_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...o.env,
  } as unknown as Bindings;
  const res = await app.request(path, { method: o.method ?? 'GET', headers }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let json: { data?: Record<string, any>; error?: { code: string } } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* plain */ }
  return { status: res.status, text, data: (json.data ?? {}) as Record<string, any>, code: json.error?.code, cache: res.headers.get('cache-control') };
}

describe.skipIf(!databaseUrl)('engagement events and insights (real PostgreSQL)', () => {
  let client: Client;
  const run = randomUUID().slice(0, 8);
  // Public display names must not look like a phone number (the profile validator refuses digit runs), so they use a digit-free form of the run id.
  const tag = run.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!);
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  let ownerA = ''; let ownerB = ''; let mod1 = ''; let mod2 = ''; let staffA = '';
  let bizA = ''; let bizB = ''; let handleA = '';
  let postA = ''; let postB = '';
  let cust: { id: string; token: string }[] = [];
  let ownerToken = ''; let ownerBToken = ''; let staffToken = '';
  let posts: NetworkBusinessPostService; let moderation: NetworkPostService;

  const makeCustomer = async () => {
    const id = (await q(`insert into customers(status, phone, phone_verified_at) values ('active', $1, now()) returning id`,
      [`+4478${Math.floor(10000000 + Math.random() * 89999999)}`]))[0].id as string;
    return { id, token: await signCustomerAccessToken(id, CUSTOMER_SECRET) };
  };
  async function newBusiness(label: string, owner: string) {
    const biz = (await q('insert into businesses(name, slug, status, default_locale) values ($1,$2,$3,$4) returning id', [`Ins ${label} ${run}`, `ins-${label}-${run}`, 'active', 'en']))[0].id as string;
    const category = (await q('select id from business_categories limit 1'))[0]?.id as string | undefined;
    if (category) await q('update businesses set category_id=$2 where id=$1', [biz, category]);
    const profiles = new BusinessProfileService(buildDb(client));
    const draft = await profiles.saveDraft(biz, { userId: owner, role: 'business' }, {
      websiteUrl: 'https://cafe.example',
      translations: [{ locale: 'en', displayName: `Cafe ${label} ${tag}`, summary: 'Coffee', description: 'Fresh coffee daily.' }],
      locations: [{ kind: 'place', label: 'Main shop', countryCode: 'GB', city: 'London' }],
    });
    const sub = await profiles.submit(biz, { userId: owner, role: 'business' }, draft.revisionId!);
    await profiles.approve(draft.revisionId!, { userId: mod1, role: 'platform_admin' }, sub.digest);
    return { biz, handle: (await q('select profile_handle from business_public_profiles where business_id=$1', [biz]))[0].profile_handle as string };
  }
  async function publish(biz: string, owner: string, text: string) {
    const created = await posts.createDraft(biz, owner, { body: text, contentLocale: 'en' });
    await posts.submit(biz, created.handle);
    const rev = (await q(`select r.id from network_post_revisions r join network_posts p on p.id=r.post_id where p.handle=$1 and r.status='submitted'`, [created.handle]))[0].id as string;
    await moderation.approve(rev, mod2);
    return created.handle;
  }
  const events = async (type: string, biz: string) => Number((await q(`select count(*)::int n from network_engagement_events where event_type=$1 and business_id=$2`, [type, biz]))[0].n);
  const insights = (token = ownerToken, biz = () => bizA, days = '30') => call(`/api/v1/community/business/insights?days=${days}`, { token, businessId: biz() });

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const admin = createRepositories(buildDb(client));
    const user = async (label: string) => (await admin.users.create({
      email: `ins-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash('unused-password-1', 1000), status: 'active',
    })).id;
    ownerA = await user('ownerA'); ownerB = await user('ownerB'); mod1 = await user('mod1'); mod2 = await user('mod2'); staffA = await user('staffA');
    const a = await newBusiness('A', ownerA); const b = await newBusiness('B', ownerB);
    bizA = a.biz; handleA = a.handle; bizB = b.biz;
    const provisioning = new RoleProvisioningService(admin);
    for (const [biz, owner] of [[bizA, ownerA], [bizB, ownerB]] as const) {
      const roles = await provisioning.seedDefaultRoles(biz, owner);
      await admin.userBusinessRoles.grant({ userId: owner, businessId: biz, branchId: null, roleId: roles.Owner, createdBy: owner });
      if (biz === bizA) await admin.userBusinessRoles.grant({ userId: staffA, businessId: biz, branchId: null, roleId: roles.Staff, createdBy: owner });
    }
    ownerToken = await signAccessToken(ownerA, STAFF_SECRET); ownerBToken = await signAccessToken(ownerB, STAFF_SECRET); staffToken = await signAccessToken(staffA, STAFF_SECRET);
    moderation = new NetworkPostService(buildDb(client));
    posts = new NetworkBusinessPostService(buildDb(client), 50);
    postA = await publish(bizA, ownerA, `Engagement post A ${run}`);
    postB = await publish(bizB, ownerB, `Engagement post B ${run}`);
    for (let i = 0; i < 12; i += 1) cust.push(await makeCustomer());
  });
  afterAll(async () => { await client?.end(); });

  it('a Feed page records ONE impression per customer, business post and day; refreshes and retries add nothing; official and invisible posts record nothing', async () => {
    const c = cust[0]!;
    const first = await call('/api/v1/network/feed', { token: c.token });
    expect(first.status).toBe(200);
    const before = await events('impression', bizA);
    expect(before).toBe(1);
    await call('/api/v1/network/feed', { token: c.token }); await call('/api/v1/network/feed', { token: c.token });
    expect(await events('impression', bizA)).toBe(1); // idempotent per day
    expect(await events('impression', bizB)).toBe(1);
    // With distribution closed the feed returns no business post, so nothing is recorded.
    const d = cust[1]!;
    await call('/api/v1/network/feed', { token: d.token, env: { NETWORK_BUSINESS_DISTRIBUTION_ENABLED: undefined } });
    expect(Number((await q(`select count(*)::int n from network_engagement_events where customer_id=$1`, [d.id]))[0].n)).toBe(0);
  });

  it('engagement: a customer opening a visible business post counts once per day; an invisible or unknown post is the same generic not-found; staff tokens cannot write', async () => {
    const c = cust[2]!;
    expect((await call(`/api/v1/network/engagement/${postA}`, { method: 'POST', token: c.token })).data).toEqual({ recorded: true });
    expect((await call(`/api/v1/network/engagement/${postA}`, { method: 'POST', token: c.token })).data).toEqual({ recorded: true });
    expect(Number((await q(`select count(*)::int n from network_engagement_events where customer_id=$1 and event_type='engagement'`, [c.id]))[0].n)).toBe(1);
    const unknown = await call(`/api/v1/network/engagement/${'A'.repeat(22)}`, { method: 'POST', token: c.token });
    const draft = await posts.createDraft(bizA, ownerA, { body: `Unpublished draft ${run}`, contentLocale: 'en' });
    const hidden = await call(`/api/v1/network/engagement/${draft.handle}`, { method: 'POST', token: c.token });
    expect([unknown.status, hidden.status]).toEqual([404, 404]);
    expect(hidden.text.replace(/\s/g, '')).toBe(unknown.text.replace(/\s/g, ''));
    expect((await call(`/api/v1/network/engagement/${postA}`, { method: 'POST', token: c.token, env: { NETWORK_BUSINESS_DISTRIBUTION_ENABLED: undefined } })).status).toBe(404);
    // A business owner's staff token is not a customer: it cannot add to its own totals.
    expect((await call(`/api/v1/network/engagement/${postA}`, { method: 'POST', token: ownerToken })).status).toBe(401);
    expect((await call(`/api/v1/network/engagement/${postA}`, { method: 'POST' })).status).toBe(401);
  });

  it('follow and unfollow are recorded as real events with their own counts', async () => {
    const c = cust[3]!;
    await call(`/api/v1/network/follows/${handleA}`, { method: 'PUT', token: c.token });
    await call(`/api/v1/network/follows/${handleA}`, { method: 'PUT', token: c.token }); // idempotent: no second event
    expect(await events('follow', bizA)).toBe(1);
    await call(`/api/v1/network/follows/${handleA}`, { method: 'DELETE', token: c.token });
    await call(`/api/v1/network/follows/${handleA}`, { method: 'DELETE', token: c.token }); // nothing to remove: no second event
    expect(await events('unfollow', bizA)).toBe(1);
  });

  it('a small audience is never disclosed: insights are all suppressed until 10 DISTINCT customers are behind a figure', async () => {
    const res = await insights();
    expect(res.status, res.text).toBe(200);
    expect(res.cache).toBe('no-store');
    for (const key of ['impressions', 'uniqueReach', 'engagements', 'newFollowers', 'currentFollowers']) expect(res.data[key], key).toEqual({ state: 'suppressed' });
    expect(res.data).toMatchObject({ minimumGroupSize: 10, attribution: { state: 'not_measured' }, profileVisits: { state: 'not_measured' }, rangeDays: 30 });
    expect(res.data.posts.find((p: { handle: string }) => p.handle === postA)).toMatchObject({ impressions: { state: 'suppressed' }, engagements: { state: 'suppressed' } });
  });

  it('with enough distinct customers the totals are shown exactly, per post as well; another business sees none of them', async () => {
    for (const c of cust) {
      await call('/api/v1/network/feed', { token: c.token });
      await call('/api/v1/network/feed', { token: c.token }); // a second visit the same day changes nothing
    }
    for (const c of cust.slice(0, 11)) await call(`/api/v1/network/engagement/${postA}`, { method: 'POST', token: c.token });
    for (const c of cust.slice(4, 12)) await call(`/api/v1/network/follows/${handleA}`, { method: 'PUT', token: c.token });
    for (const c of cust.slice(0, 3)) await call(`/api/v1/network/follows/${handleA}`, { method: 'PUT', token: c.token });
    const res = await insights();
    expect(res.data).toMatchObject({
      impressions: { state: 'shown', value: 12 }, uniqueReach: { state: 'shown', value: 12 }, engagements: { state: 'shown', value: 11 },
      newFollowers: { state: 'shown', value: 12 }, currentFollowers: { state: 'shown', value: 11 },
    });
    expect(res.data.posts.find((p: { handle: string }) => p.handle === postA)).toMatchObject({ impressions: { state: 'shown', value: 12 }, engagements: { state: 'shown', value: 11 } });
    const other = await insights(ownerBToken, () => bizB);
    expect(other.data.engagements).toEqual({ state: 'suppressed' });
    expect(other.data.impressions).toEqual({ state: 'shown', value: 12 }); // B's own impressions only
    expect(JSON.stringify(other.data)).not.toContain(postA);
    expect(JSON.stringify(res.data)).not.toMatch(new RegExp(`${cust[0]!.id}|${bizA}|${ownerA}|customer`, 'i'));
  });

  it('the date range counts UTC days: old events fall outside 30 days and inside 90; bad ranges are 400', async () => {
    const old = await makeCustomerRows(12, 40);
    expect(old).toBe(12);
    const r30 = await insights(ownerToken, () => bizA, '30');
    const r90 = await insights(ownerToken, () => bizA, '90');
    expect(r30.data.impressions).toMatchObject({ state: 'shown', value: 12 });
    expect(r90.data.impressions).toMatchObject({ state: 'shown', value: 24 });
    expect(r30.data.from < r30.data.to && r90.data.from < r30.data.from).toBe(true);
    for (const bad of ['0', '1', '31', 'x', '7;8', '']) expect((await insights(ownerToken, () => bizA, bad)).status, bad).toBe(400);
    expect((await call('/api/v1/community/business/insights?days=7&days=30', { token: ownerToken, businessId: bizA })).status).toBe(400);
    expect((await call('/api/v1/community/business/insights?customerId=x', { token: ownerToken, businessId: bizA })).status).toBe(400);
  });
  async function makeCustomerRows(n: number, daysAgo: number) {
    let inserted = 0;
    for (let i = 0; i < n; i += 1) {
      const c = await makeCustomer();
      const r = await q(`insert into network_engagement_events(customer_id, business_id, subject_id, event_type, occurred_at, event_day)
        values ($1,$2,(select id from network_posts where handle=$3),'impression', now() - ($4 || ' days')::interval, to_char((now() at time zone 'UTC')::date - $4::int, 'YYYY-MM-DD')) returning 1`,
        [c.id, bizA, postA, String(daysAgo)]);
      inserted += r.length;
    }
    return inserted;
  }

  it('authorization: staff without the hub permission, a foreign owner, an outsider and anonymous callers are refused', async () => {
    for (const r of [await insights(staffToken), await insights(ownerBToken), await call('/api/v1/community/business/insights', { businessId: bizA })]) {
      expect([401, 403, 404]).toContain(r.status);
      expect(Object.keys(r.data)).toEqual([]);
    }
  });

  it('events are append-only and leave only with the customer; nothing else is touched', async () => {
    await expect(q(`update network_engagement_events set event_type='follow' where customer_id=$1`, [cust[0]!.id])).rejects.toThrow(/append-only/);
    await expect(q('truncate network_engagement_events')).rejects.toThrow(/TRUNCATE_DENIED|NETWORK_TRUNCATE/);
    const tables = ['community_memberships', 'community_point_accounts', 'community_point_transactions', 'consent_grants', 'loyalty_accounts', 'loyalty_transactions', 'notifications'];
    const fingerprint = async () => Object.fromEntries(await Promise.all(tables.map(async (t) =>
      [t, (await q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from ${t} x`))[0]])));
    const before = await fingerprint();
    await call(`/api/v1/network/engagement/${postB}`, { method: 'POST', token: cust[5]!.token });
    await insights();
    expect(await fingerprint()).toEqual(before);
    const victim = cust[11]!.id;
    expect(Number((await q('select count(*)::int n from network_engagement_events where customer_id=$1', [victim]))[0].n)).toBeGreaterThan(0);
    await q('delete from customers where id=$1', [victim]);
    expect(Number((await q('select count(*)::int n from network_engagement_events where customer_id=$1', [victim]))[0].n)).toBe(0);
  });
});
