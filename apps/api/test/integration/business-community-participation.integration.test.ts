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

/**
 * BCOMM-02: GET /community/business/participation through the real route, tenant resolution and PostgreSQL: privacy-protected totals, small-group
 * suppression, tenant isolation, authorization, and proof that reading writes nothing and returns no identifying data.
 */
const databaseUrl = process.env.DATABASE_URL;
const SECRET = 'business-community-participation-secret';
const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/community/business', communityBusinessRoutes);
app.onError(errorHandler);

type Call = { token?: string; businessId?: string; env?: Record<string, unknown> };
type Figure = { state: 'shown'; value: number } | { state: 'suppressed' };
async function participation(call: Call = {}) {
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
  const response = await app.request('/api/v1/community/business/participation', { headers }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  let body: { data?: { minimumGroupSize: number; eligible: Figure; participants: Figure; ratePercent: Figure } } = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* plain text */ }
  return { status: response.status, cache: response.headers.get('cache-control'), text, ...body };
}

describe.skipIf(!databaseUrl)('business Community participation totals (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  const run = randomUUID().slice(0, 8);
  let bizA: string; let bizB: string; let a1: string;
  const tok: Record<string, string> = {};
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;

  async function addCustomers(businessId: string, count: number, opts: { members?: number; status?: string; suspendedAccounts?: number; deletedAccounts?: number; memberStatus?: string } = {}) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = (await q("insert into customers(status) values ('active') returning id"))[0].id as string;
      ids.push(id);
      const account = i < (opts.suspendedAccounts ?? 0) ? 'suspended' : 'active';
      const deleted = i >= (opts.suspendedAccounts ?? 0) && i < (opts.suspendedAccounts ?? 0) + (opts.deletedAccounts ?? 0);
      await q('insert into loyalty_accounts(customer_id, business_id, status, is_deleted) values ($1,$2,$3,$4)', [id, businessId, account, deleted]);
    }
    for (const id of ids.slice(-(opts.members ?? 0))) {
      const status = opts.memberStatus ?? 'active';
      await q("insert into community_memberships(customer_id,status,policy_version,left_at) values ($1,$2,'synthetic-participation-test', case when $2 = 'left' then now() end)", [id, status]);
    }
    return ids;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const admin = createRepositories(buildDb(client));
    const user = async (label: string) => (await admin.users.create({
      email: `bp-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash('unused-password-1', 1000), status: 'active',
    })).id;
    const ids = { ownerA: await user('owner-a'), managerA: await user('manager-a'), staffA: await user('staff-a'),
      branchStaffA: await user('branch-staff-a'), ownerB: await user('owner-b'), outsider: await user('outsider') };
    bizA = (await admin.businesses.create({ name: 'Part A', slug: `bp-a-${run}` })).id;
    bizB = (await admin.businesses.create({ name: 'Part B', slug: `bp-b-${run}` })).id;
    a1 = (await admin.branches.create({ businessId: bizA, name: 'A1', slug: 'a1' })).id;
    const provisioning = new RoleProvisioningService(admin);
    const rolesA = await provisioning.seedDefaultRoles(bizA, ids.ownerA);
    const rolesB = await provisioning.seedDefaultRoles(bizB, ids.ownerB);
    const grant = (userId: string, businessId: string, roleId: string, branchId: string | null) =>
      admin.userBusinessRoles.grant({ userId, businessId, branchId, roleId, createdBy: userId });
    await grant(ids.ownerA, bizA, rolesA.Owner, null);
    await grant(ids.managerA, bizA, rolesA.Manager, null);
    await grant(ids.staffA, bizA, rolesA.Staff, null);
    await grant(ids.branchStaffA, bizA, rolesA.Manager, a1);
    await grant(ids.ownerB, bizB, rolesB.Owner, null);
    for (const [key, id] of Object.entries(ids)) tok[key] = await signAccessToken(id, SECRET);
  });
  afterAll(async () => { await client?.end(); });

  it('an empty business sees every figure suppressed (no count of any kind), uncached', async () => {
    const res = await participation({ token: tok.ownerA!, businessId: bizA });
    expect(res.status, res.text).toBe(200);
    expect(res.data).toEqual({ minimumGroupSize: 10, eligible: { state: 'suppressed' }, participants: { state: 'suppressed' }, ratePercent: { state: 'suppressed' } });
    expect(res.cache).toBe('no-store');
  });

  it('counts only this business\'s ACTIVE, non-deleted loyalty customers and ACTIVE memberships; another business never leaks in', async () => {
    // Business A: 40 countable customers, 15 of them Community members. Not counted: 2 suspended accounts, 3 soft-deleted accounts, and
    // 4 customers whose membership has LEFT. Business B has 30 customers (20 members) that must never appear in A's totals.
    await addCustomers(bizA, 40, { members: 15 });
    await addCustomers(bizA, 2, { suspendedAccounts: 2 });
    await addCustomers(bizA, 3, { deletedAccounts: 3 });
    await addCustomers(bizA, 4, { members: 4, memberStatus: 'left' });
    await addCustomers(bizB, 30, { members: 20 });
    const a = await participation({ token: tok.ownerA!, businessId: bizA });
    expect(a.data).toMatchObject({ eligible: { state: 'shown', value: 44 }, participants: { state: 'shown', value: 15 }, ratePercent: { state: 'shown', value: 34 } });
    const b = await participation({ token: tok.ownerB!, businessId: bizB });
    expect(b.data).toMatchObject({ eligible: { state: 'shown', value: 30 }, participants: { state: 'shown', value: 20 }, ratePercent: { state: 'shown', value: 67 } });
  });

  it('a manager of the business receives the same totals; the configured group size can only raise the threshold', async () => {
    expect((await participation({ token: tok.managerA!, businessId: bizA })).data?.eligible).toEqual({ state: 'shown', value: 44 });
    const raised = await participation({ token: tok.ownerA!, businessId: bizA, env: { COMMUNITY_AGGREGATE_MIN_GROUP_SIZE: '20' } });
    expect(raised.data).toMatchObject({ minimumGroupSize: 20, eligible: { state: 'shown', value: 44 }, participants: { state: 'suppressed' } });
    for (const lowered of ['1', '0', 'abc', '5']) {
      expect((await participation({ token: tok.ownerA!, businessId: bizA, env: { COMMUNITY_AGGREGATE_MIN_GROUP_SIZE: lowered } })).data?.minimumGroupSize, lowered).toBe(10);
    }
  });

  it('suppresses a small participant group and a small remainder (no disclosure by subtraction)', async () => {
    const small = (await q("insert into businesses(name, slug) values ('Small', $1) returning id", [`bp-s-${run}`]))[0].id as string;
    await addCustomers(small, 25, { members: 9 });
    // An owner of this extra business reads its totals through the same route.
    const ownerId = (await q("insert into users(email, full_name, password_hash, status) values ($1,'o','x','active') returning id", [`bp-small-${run}@example.test`]))[0].id as string;
    const roles = await new RoleProvisioningService(createRepositories(buildDb(client))).seedDefaultRoles(small, ownerId);
    await createRepositories(buildDb(client)).userBusinessRoles.grant({ userId: ownerId, businessId: small, branchId: null, roleId: roles.Owner, createdBy: ownerId });
    const token = await signAccessToken(ownerId, SECRET);
    expect((await participation({ token, businessId: small })).data).toMatchObject({ eligible: { state: 'shown', value: 25 }, participants: { state: 'suppressed' }, ratePercent: { state: 'suppressed' } });
    await q("insert into community_memberships(customer_id,status,policy_version) select customer_id,'active','synthetic-participation-test' from loyalty_accounts la where la.business_id=$1 and not exists (select 1 from community_memberships m where m.customer_id=la.customer_id) limit 11", [small]);
    // now 20 members of 25: the remainder (5) is a small group, so participants stay hidden.
    expect((await participation({ token, businessId: small })).data).toMatchObject({ eligible: { state: 'shown', value: 25 }, participants: { state: 'suppressed' } });
  });

  it('refuses view-only staff, a branch-scoped manager, a foreign owner, an outsider and an anonymous caller (server-side)', async () => {
    const refused = [
      await participation({ token: tok.staffA!, businessId: bizA }),
      await participation({ token: tok.branchStaffA!, businessId: bizA }),
      await participation({ token: tok.ownerB!, businessId: bizA }),
      await participation({ token: tok.outsider!, businessId: bizA }),
      await participation({ businessId: bizA }),
      await participation({ token: 'not-a-token', businessId: bizA }),
    ];
    for (const r of refused) expect([401, 403], r.text).toContain(r.status);
    expect(refused.every((r) => r.data === undefined)).toBe(true);
    expect([401, 403, 404]).toContain((await participation({ token: tok.ownerA!, businessId: bizB })).status);
  });

  it('is read-only and returns only counts: no row changes, and no identifier, name, contact, points or consent field leaves', async () => {
    const tables = ['community_memberships', 'community_point_accounts', 'community_point_transactions', 'consent_grants', 'audit_log',
      'customers', 'customer_deletion_requests', 'notifications', 'business_customer_memberships', 'loyalty_accounts'];
    const fingerprint = async () => Object.fromEntries(await Promise.all(tables.map(async (t) =>
      [t, (await q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from ${t} x`))[0]])));
    const before = await fingerprint();
    const res = await participation({ token: tok.ownerA!, businessId: bizA });
    expect(res.status).toBe(200);
    expect(Object.keys(res.data!).sort()).toEqual(['eligible', 'minimumGroupSize', 'participants', 'ratePercent']);
    expect(res.text).not.toMatch(/customer_?id|uuid|email|phone|points|balance|consent|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(await fingerprint()).toEqual(before);
  });
});
