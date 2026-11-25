import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { errorHandler } from '../../src/lib/error-handler';
import { communityBusinessRoutes } from '../../src/community/community-business.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { pbkdf2Hash } from '../../src/auth/password';
import { appDbOf } from '../helpers/runtime-db';

/**
 * BCOMM-01: GET /community/business/status through the real route, tenant resolution and PostgreSQL. It is read-only and data-free, so beside the
 * authorization matrix the suite proves that reading it writes nothing anywhere and that the answer follows the existing runtime controls.
 */
const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'business-community-status-secret';
const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/community/business', communityBusinessRoutes);
app.onError(errorHandler);

type Call = { token?: string; businessId?: string; env?: Record<string, unknown> };
async function status(call: Call = {}) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (call.token) headers.set('Authorization', `Bearer ${call.token}`);
  if (call.businessId) headers.set('X-Business-Id', call.businessId);
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl },
    JWT_ACCESS_SECRET: SECRET,
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...call.env,
  } as unknown as Bindings;
  const response = await app.request('/api/v1/community/business/status', { headers }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  let body: { data?: { enrollment: string; feed: string; publishing: string }; error?: { code: string } } = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* plain text */ }
  return { status: response.status, cache: response.headers.get('cache-control'), text, ...body };
}

describe.skipIf(!databaseUrl)('business Community status (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  const run = randomUUID().slice(0, 8);
  let bizA: string; let bizB: string; let a1: string;
  const tok: Record<string, string> = {};
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const repos = createRepositories(appDbOf(buildDb(client)));
    const admin = createRepositories(buildDb(client));
    const user = async (label: string) => (await admin.users.create({
      email: `bc-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash('unused-password-1', 1000), status: 'active',
    })).id;
    const ids = { ownerA: await user('owner-a'), adminA: await user('admin-a'), managerA: await user('manager-a'), staffA: await user('staff-a'),
      branchStaffA: await user('branch-staff-a'), ownerB: await user('owner-b'), outsider: await user('outsider') };
    bizA = (await admin.businesses.create({ name: 'Hub A', slug: `bc-a-${run}` })).id;
    bizB = (await admin.businesses.create({ name: 'Hub B', slug: `bc-b-${run}` })).id;
    a1 = (await admin.branches.create({ businessId: bizA, name: 'A1', slug: 'a1' })).id;
    const provisioning = new RoleProvisioningService(admin);
    const rolesA = await provisioning.seedDefaultRoles(bizA, ids.ownerA);
    const rolesB = await provisioning.seedDefaultRoles(bizB, ids.ownerB);
    const grant = (userId: string, businessId: string, roleId: string, branchId: string | null) =>
      admin.userBusinessRoles.grant({ userId, businessId, branchId, roleId, createdBy: userId });
    await grant(ids.ownerA, bizA, rolesA.Owner, null);
    await grant(ids.adminA, bizA, rolesA.Admin, null);
    await grant(ids.managerA, bizA, rolesA.Manager, null);
    await grant(ids.staffA, bizA, rolesA.Staff, null); // business-wide but view-only permissions
    await grant(ids.branchStaffA, bizA, rolesA.Manager, a1); // a manager role limited to one branch is not business-wide
    await grant(ids.ownerB, bizB, rolesB.Owner, null);
    for (const [key, id] of Object.entries(ids)) tok[key] = await signAccessToken(id, SECRET);
    void repos;
  });
  afterAll(async () => { await client?.end(); });

  it('an owner, an admin and a manager of the business receive the rollout state; nothing is cached', async () => {
    for (const who of ['ownerA', 'adminA', 'managerA']) {
      const res = await status({ token: tok[who]!, businessId: bizA });
      expect(res.status, `${who}: ${res.text}`).toBe(200);
      expect(res.data).toEqual({ enrollment: 'closed', feed: 'closed', publishing: 'closed' });
      expect(res.cache).toBe('no-store');
    }
  });

  it('reports the real runtime controls: open only for the exact string "true", publishing always closed', async () => {
    const token = tok.ownerA!;
    const open = (env: Record<string, unknown>) => status({ token, businessId: bizA, env });
    expect((await open({ COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'true' })).data).toMatchObject({ enrollment: 'open', feed: 'closed', publishing: 'closed' });
    expect((await open({ COMMUNITY_MEMBERSHIP_RESTORE_ENABLED: 'true' })).data?.enrollment).toBe('open');
    for (const value of ['TRUE', ' true', '1', 'yes', '', true, undefined, 'false']) {
      expect((await open({ COMMUNITY_MEMBERSHIP_JOIN_ENABLED: value })).data?.enrollment, String(value)).toBe('closed');
    }
    // The clearance gate is platform staff only and never counts as customer enrollment; the Feed flag is independent of enrollment.
    expect((await open({ COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED: 'true' })).data?.enrollment).toBe('closed');
    expect((await open({ NETWORK_FEED_ENABLED: 'true' })).data).toMatchObject({ enrollment: 'closed', feed: 'open', publishing: 'closed' });
    expect((await open({ NETWORK_FEED_ENABLED: 'true', COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'true' })).data).toEqual({ enrollment: 'open', feed: 'open', publishing: 'closed' });
  });

  it('refuses view-only staff, a branch-scoped manager, a foreign owner, an outsider and an anonymous caller (server-side)', async () => {
    const refused = [
      await status({ token: tok.staffA!, businessId: bizA }),
      await status({ token: tok.branchStaffA!, businessId: bizA }),
      await status({ token: tok.ownerB!, businessId: bizA }), // owner of ANOTHER business naming this business
      await status({ token: tok.outsider!, businessId: bizA }),
      await status({ businessId: bizA }),
      await status({ token: 'not-a-token', businessId: bizA }),
    ];
    for (const r of refused) expect([401, 403], r.text).toContain(r.status);
    expect(refused.every((r) => r.data === undefined)).toBe(true);
    // A real owner naming a business they do not belong to is refused too (no cross-business reads).
    expect([401, 403, 404]).toContain((await status({ token: tok.ownerA!, businessId: bizB })).status);
  });

  it('is read-only and data-free: no row anywhere changes, no customer, consent, membership or points data is touched or returned', async () => {
    const tables = ['community_memberships', 'community_point_accounts', 'community_point_transactions', 'consent_grants', 'audit_log',
      'customers', 'customer_deletion_requests', 'notifications', 'business_customer_memberships', 'loyalty_accounts'];
    const fingerprint = async () => Object.fromEntries(await Promise.all(tables.map(async (t) =>
      [t, (await q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from ${t} x`))[0]])));
    const before = await fingerprint();
    const res = await status({ token: tok.ownerA!, businessId: bizA, env: { COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'true', NETWORK_FEED_ENABLED: 'true' } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.data!).sort()).toEqual(['enrollment', 'feed', 'publishing']);
    expect(res.text).not.toMatch(/customer|member|points|balance|consent|count/i);
    expect(await fingerprint()).toEqual(before);
  });

  it('the answer is identical for every business (no tenant data) and does not depend on which manager asks', async () => {
    const a = await status({ token: tok.ownerA!, businessId: bizA, env: { NETWORK_FEED_ENABLED: 'true' } });
    const b = await status({ token: tok.ownerB!, businessId: bizB, env: { NETWORK_FEED_ENABLED: 'true' } });
    expect(a.data).toEqual(b.data);
  });
});
