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
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { authRoutes } from '../../src/auth/auth.routes';
import { businessRoutes } from '../../src/businesses/business.routes';
import { cashierAccountRoutes } from '../../src/cashier-accounts/cashier-accounts.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';

/**
 * CASHIER-AUTH-02B against REAL Postgres and the REAL middleware: explicit single-branch and multiple-branch assignment of a
 * managed cashier, branch isolation at sign-in and on every request, and the effect of removing an assignment. In-session
 * branch switching (02C) is NOT tested because it is not implemented.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Managed cashier tests need a loopback PostgreSQL database.');
}

const SECRET = 'managed-cashier-branches-access-secret';
const REFRESH_SECRET = 'managed-cashier-branches-refresh-secret';
const run = randomUUID();
const allow = { limit: async () => ({ success: true }) };
const hasherNamespace = {
  newUniqueId: () => ({}),
  get: () => ({
    fetch: async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { action: string; input: string; storedHash?: string };
      const result = body.action === 'hash' ? await pbkdf2Hash(body.input, 1000) : await pbkdf2Verify(body.input, body.storedHash ?? '');
      return Response.json({ result });
    },
  }),
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/businesses', businessRoutes);
app.route('/api/v1/cashier-accounts', cashierAccountRoutes);
app.onError(errorHandler);

// The response envelope is asserted field by field across many shapes; a loose test-only type keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
interface Call { token?: string; businessId?: string; branchId?: string; body?: unknown; headers?: Record<string, string> }

async function http(method: string, path: string, call: Call = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers(call.headers);
  if (call.token) headers.set('Authorization', `Bearer ${call.token}`);
  if (call.businessId) headers.set('X-Business-Id', call.businessId);
  if (call.branchId) headers.set('X-Branch-Id', call.branchId);
  if (call.body !== undefined) headers.set('Content-Type', 'application/json');
  const env = {
    HYPERDRIVE: { connectionString: databaseUrl }, JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET,
    PASSWORD_HASHER: hasherNamespace, AUTH_RATE_LIMITER: allow, API_RATE_LIMITER: allow,
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, {
    method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  return { status: response.status, ...(text ? (JSON.parse(text) as Envelope) : {}) };
}

describe.skipIf(!databaseUrl)('CASHIER-AUTH-02B managed cashier branch assignment (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const PW = 'an-admin-password-1';
  let bizA: string; let bizB: string;
  let a1: string; let a2: string; let a3: string; let b1: string;
  let ownerA: string; let adminA: string; let managerA: string; let ownerB: string;
  const tok: Record<string, string> = {};
  let code = '';

  const user = async (label: string) => (await repos.users.create({
    email: `mcb-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash(PW, 1000), status: 'active',
  })).id;
  type Who = 'ownerA' | 'adminA' | 'ownerB';
  const adminCall = async (method: string, path: string, body?: unknown, who: Who = 'ownerA') => {
    const businessId = who === 'ownerB' ? bizB : bizA;
    const proof = await http('POST', '/cashier-accounts/reauth', { token: tok[who]!, businessId, body: { password: PW } });
    return http(method, path, { token: tok[who]!, businessId, headers: { 'X-Reauth-Proof': proof.data.proof }, ...(body === undefined ? {} : { body }) });
  };
  const create = (username: string, accessMode: 'single' | 'multiple', branchIds: string[], who: Who = 'ownerA') =>
    adminCall('POST', '/cashier-accounts', { username, displayName: `Till ${username}`, accessMode, branchIds, password: 'cashier-pass-1' }, who);
  const assign = (id: string, accessMode: string, branchIds: string[], who: Who = 'ownerA') =>
    adminCall('PUT', `/cashier-accounts/${id}/branches`, { accessMode, branchIds }, who);
  const signIn = (username: string, password = 'cashier-pass-1') =>
    http('POST', '/auth/cashier/managed-login', { body: { businessCode: code, username, password } });
  const select = (ticket: string, businessId: string, branchId?: string) =>
    http('POST', '/auth/cashier/session', { body: { ticket, businessId, ...(branchId ? { branchId } : {}) } });
  const grants = async (id: string) => (await q(
    `SELECT branch_id, deleted_at FROM user_business_roles WHERE user_id = $1 ORDER BY created_at`, [id]));
  const active = async (id: string) => (await q(
    `SELECT branch_id FROM user_business_roles WHERE user_id = $1 AND deleted_at IS NULL ORDER BY branch_id`, [id])).map((r) => r.branch_id as string);

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    repos = createRepositories(buildDb(client));
    ownerA = await user('owner-a'); adminA = await user('admin-a'); managerA = await user('manager-a'); ownerB = await user('owner-b');
    bizA = (await repos.businesses.create({ name: 'Branches A', slug: `mcb-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: 'Branches B', slug: `mcb-b-${run}` })).id;
    a1 = (await repos.branches.create({ businessId: bizA, name: 'A1', slug: 'a1' })).id;
    a2 = (await repos.branches.create({ businessId: bizA, name: 'A2', slug: 'a2' })).id;
    a3 = (await repos.branches.create({ businessId: bizA, name: 'A3', slug: 'a3' })).id;
    b1 = (await repos.branches.create({ businessId: bizB, name: 'B1', slug: 'b1' })).id;
    const provisioning = new RoleProvisioningService(repos);
    const rolesA = await provisioning.seedDefaultRoles(bizA, ownerA);
    const rolesB = await provisioning.seedDefaultRoles(bizB, ownerB);
    const grant = (userId: string, businessId: string, roleId: string) => repos.userBusinessRoles.grant({ userId, businessId, branchId: null, roleId, createdBy: userId });
    await grant(ownerA, bizA, rolesA.Owner); await grant(adminA, bizA, rolesA.Admin);
    await grant(managerA, bizA, rolesA.Manager); await grant(ownerB, bizB, rolesB.Owner);
    for (const [key, id] of Object.entries({ ownerA, adminA, managerA, ownerB })) tok[key] = await signAccessToken(id, SECRET);
    const first = await create('seedcode', 'single', [a1]);
    expect(first.status, JSON.stringify(first)).toBe(201);
    code = first.data.cashierCode;
  });
  afterAll(async () => { await client?.end(); });

  describe('creating with an explicit assignment', () => {
    it('single branch = exactly one; multiple branches = two or more, each explicit', async () => {
      const single = await create('single1', 'single', [a1]);
      expect(single.status, JSON.stringify(single)).toBe(201);
      expect(single.data.account.accessMode).toBe('single');
      expect(await active(single.data.account.id)).toEqual([a1]);
      const multi = await create('multi1', 'multiple', [a1, a3]);
      expect(multi.status).toBe(201);
      expect(multi.data.account.accessMode).toBe('multiple');
      expect(multi.data.account.branches.map((b: { id: string }) => b.id).sort()).toEqual([a1, a3].sort());
      expect(await active(multi.data.account.id)).toEqual([a1, a3].sort());
    });

    it('rejects an invalid mode/count combination, duplicates that collapse, an empty list, and mixing both request shapes', async () => {
      expect((await create('bad1', 'single', [a1, a2])).error?.code).toBe('CASHIER_BRANCH_ASSIGNMENT_INVALID');
      expect((await create('bad2', 'multiple', [a1])).error?.code).toBe('CASHIER_BRANCH_ASSIGNMENT_INVALID');
      expect((await create('bad3', 'multiple', [a1, a1])).error?.code).toBe('CASHIER_BRANCH_ASSIGNMENT_INVALID');
      expect((await create('bad4', 'multiple', [])).status).toBe(400);
      expect((await adminCall('POST', '/cashier-accounts', { username: 'bad5', displayName: 'x', branchId: a1, branchIds: [a1] })).status).toBe(400);
      expect((await adminCall('POST', '/cashier-accounts', { username: 'bad6', displayName: 'x', accessMode: 'everything', branchIds: [a1] })).status).toBe(400);
      expect(await q(`SELECT 1 FROM users WHERE managed_business_id = $1 AND login_username LIKE 'bad%'`, [bizA])).toHaveLength(0);
    });

    it('rejects branches of another business or unknown branches, and creates nothing', async () => {
      expect((await create('foreign1', 'single', [b1])).error?.code).toBe('CASHIER_BRANCH_NOT_FOUND');
      expect((await create('foreign2', 'multiple', [a1, b1])).error?.code).toBe('CASHIER_BRANCH_NOT_FOUND');
      expect((await create('foreign3', 'multiple', [a1, randomUUID()])).error?.code).toBe('CASHIER_BRANCH_NOT_FOUND');
      expect(await q(`SELECT 1 FROM users WHERE managed_business_id = $1 AND login_username LIKE 'foreign%'`, [bizA])).toHaveLength(0);
    });

    it('the 02A request shape (one branchId) still works', async () => {
      const legacy = await adminCall('POST', '/cashier-accounts', { username: 'legacy1', displayName: 'x', branchId: a2, password: 'cashier-pass-1' });
      expect(legacy.status, JSON.stringify(legacy)).toBe(201);
      expect(legacy.data.account.accessMode).toBe('single');
    });

    it('a branch created later is never added automatically', async () => {
      const multi = (await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'multi1'`, [bizA]))[0].id as string;
      const a4 = (await repos.branches.create({ businessId: bizA, name: 'A4', slug: 'a4' })).id;
      expect(await active(multi)).toEqual([a1, a3].sort());
      expect((await repos.permissions.findEffectiveKeys(multi, bizA, a4)).has('loyalty:serve')).toBe(false);
      const login = await signIn('multi1');
      expect(login.data.choices[0].branches.map((b: { id: string }) => b.id)).not.toContain(a4);
      const ticket = login.data.ticket as string;
      expect((await select(ticket, bizA, a4)).error?.code).toBe('CASHIER_ACCESS_DENIED');
    });
  });

  describe('sign-in respects exactly the assigned branches', () => {
    it('a single-branch cashier is bound to its branch with no choice to make', async () => {
      const res = await signIn('single1');
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('authenticated');
      expect(res.data.session).toMatchObject({ businessId: bizA, branchId: a1, branchName: 'A1' });
    });

    it('a multi-branch cashier must choose among exactly its branches; an unassigned or foreign branch is refused server-side', async () => {
      const login = await signIn('multi1');
      expect(login.status).toBe(200);
      expect(login.data.status).toBe('selection_required');
      expect(login.data.choices).toHaveLength(1);
      expect(login.data.choices[0].businessId).toBe(bizA);
      expect(login.data.choices[0].wideAccess).toBe(false);
      expect(login.data.choices[0].branches.map((b: { id: string }) => b.id).sort()).toEqual([a1, a3].sort());
      const ticket = login.data.ticket as string;
      expect((await select(ticket, bizA)).error?.code).toBe('CASHIER_SELECTION_INVALID'); // a branch is mandatory
      expect((await select(ticket, bizA, a2)).error?.code).toBe('CASHIER_ACCESS_DENIED'); // same business, not assigned
      expect((await select(ticket, bizA, b1)).error?.code).toBe('CASHIER_ACCESS_DENIED'); // another business's branch
      expect((await select(ticket, bizB, b1)).error?.code).toBe('CASHIER_ACCESS_DENIED'); // another business entirely
      const chosen = await select(ticket, bizA, a3);
      expect(chosen.status, JSON.stringify(chosen)).toBe(200);
      expect(chosen.data.session).toMatchObject({ businessId: bizA, branchId: a3, branchName: 'A3' });
      expect((await select(ticket, bizA, a1)).error?.code).toBe('CASHIER_SELECTION_INVALID'); // the ticket is single-use
    });
  });

  describe('every request is bound to the session branch (a client-supplied branch is never proof)', () => {
    it('the session sees only its own branch and the counter permissions, and any other branch or business header is refused', async () => {
      const token = (await signIn('single1')).data.accessToken as string;
      const me = await http('GET', '/businesses/me', { token });
      expect(me.status).toBe(200);
      expect(me.data.branchId).toBe(a1);
      expect(me.data.permissions.sort()).toEqual(['branches:view', 'business:view', 'loyalty:serve']);
      expect((await http('GET', '/businesses/me', { token, businessId: bizA, branchId: a1 })).status).toBe(200);
      for (const header of [{ branchId: a2 }, { branchId: a3 }, { branchId: b1 }, { businessId: bizB }, { businessId: bizB, branchId: b1 }]) {
        const res = await http('GET', '/businesses/me', { token, ...header });
        expect(res.status, JSON.stringify(header)).toBe(403);
        expect(res.error?.code).toBe('CASHIER_CONTEXT_MISMATCH');
      }
    });

    it('a multi-branch cashier session bound to one branch cannot act on its other assigned branch without a new selection', async () => {
      const login = await signIn('multi1');
      const session = await select(login.data.ticket, bizA, a1);
      const token = session.data.accessToken as string;
      expect((await http('GET', '/businesses/me', { token, branchId: a1 })).status).toBe(200);
      expect((await http('GET', '/businesses/me', { token, branchId: a3 })).error?.code).toBe('CASHIER_CONTEXT_MISMATCH');
    });
  });

  describe('changing the assignment (authorization, atomicity, session effects)', () => {
    it('single to multiple keeps the live session, adds the new branch, and is audited', async () => {
      const made = await create('grow1', 'single', [a1]);
      const id = made.data.account.id as string;
      const live = (await signIn('grow1')).data;
      const res = await assign(id, 'multiple', [a1, a2]);
      expect(res.status, JSON.stringify(res)).toBe(200);
      expect(res.data.accessMode).toBe('multiple');
      expect(await active(id)).toEqual([a1, a2].sort());
      expect((await http('GET', '/auth/me', { token: live.accessToken })).status).toBe(200); // a1 was kept, so its session is untouched
      const audit = await q(`SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'cashier_account.branches_changed'`, [id]);
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ accessMode: 'multiple', added: [a2], removed: [], sessionsRevoked: 0 });
      expect(JSON.stringify(audit[0].metadata)).not.toContain('cashier-pass-1');
    });

    it('removing a branch ends ONLY the sessions bound to it, at once, and the branch can no longer be selected', async () => {
      const made = await create('shrink1', 'multiple', [a1, a2, a3]);
      const id = made.data.account.id as string;
      const onA1 = (await select((await signIn('shrink1')).data.ticket, bizA, a1)).data;
      const onA2 = (await select((await signIn('shrink1')).data.ticket, bizA, a2)).data;
      expect((await http('GET', '/businesses/me', { token: onA1.accessToken })).status).toBe(200);
      const res = await assign(id, 'multiple', [a2, a3]);
      expect(res.status, JSON.stringify(res)).toBe(200);
      expect(await active(id)).toEqual([a2, a3].sort());
      // The session on the removed branch is dead on the very next request, and cannot be refreshed.
      expect((await http('GET', '/businesses/me', { token: onA1.accessToken })).status).toBe(401);
      expect((await http('POST', '/auth/cashier/refresh', { body: { refreshToken: onA1.refreshToken } })).status).toBeGreaterThanOrEqual(401);
      // The session on a kept branch is untouched.
      expect((await http('GET', '/businesses/me', { token: onA2.accessToken })).status).toBe(200);
      // The removed branch is no longer offered nor accepted.
      const again = await signIn('shrink1');
      expect(again.data.choices[0].branches.map((b: { id: string }) => b.id).sort()).toEqual([a2, a3].sort());
      expect((await select(again.data.ticket, bizA, a1)).error?.code).toBe('CASHIER_ACCESS_DENIED');
      // History is kept: the removed grant is soft-deleted, not erased.
      const history = await grants(id);
      expect(history.filter((g) => g.deleted_at !== null).map((g) => g.branch_id)).toEqual([a1]);
      const audit = await q(`SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'cashier_account.branches_changed'`, [id]);
      expect(audit[0].metadata).toMatchObject({ removed: [a1], sessionsRevoked: 1 });
    });

    it('multiple to single leaves exactly one branch and signs in directly; re-adding a removed branch works', async () => {
      const made = await create('flip1', 'multiple', [a1, a2]);
      const id = made.data.account.id as string;
      expect((await assign(id, 'single', [a2])).data.accessMode).toBe('single');
      const direct = await signIn('flip1');
      expect(direct.data.status).toBe('authenticated');
      expect(direct.data.session.branchId).toBe(a2);
      expect((await assign(id, 'multiple', [a1, a2])).status).toBe(200);
      expect(await active(id)).toEqual([a1, a2].sort());
      expect((await q(`SELECT 1 FROM user_business_roles WHERE user_id = $1 AND deleted_at IS NULL`, [id]))).toHaveLength(2);
    });

    it('an unchanged assignment is accepted and writes no audit row', async () => {
      const made = await create('same1', 'multiple', [a1, a2]);
      const id = made.data.account.id as string;
      expect((await assign(id, 'multiple', [a2, a1])).status).toBe(200);
      expect(await q(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'cashier_account.branches_changed'`, [id])).toHaveLength(0);
    });

    it('is refused for a bad mode/count, a foreign or unknown branch, an unknown or revoked account, and changes nothing', async () => {
      const made = await create('guard1', 'single', [a1]);
      const id = made.data.account.id as string;
      expect((await assign(id, 'single', [a1, a2])).error?.code).toBe('CASHIER_BRANCH_ASSIGNMENT_INVALID');
      expect((await assign(id, 'multiple', [a1])).error?.code).toBe('CASHIER_BRANCH_ASSIGNMENT_INVALID');
      expect((await assign(id, 'multiple', [a1, b1])).error?.code).toBe('CASHIER_BRANCH_NOT_FOUND');
      expect((await assign(id, 'multiple', [a1, randomUUID()])).error?.code).toBe('CASHIER_BRANCH_NOT_FOUND');
      expect((await assign(randomUUID(), 'single', [a1])).error?.code).toBe('CASHIER_ACCOUNT_NOT_FOUND');
      expect((await assign('not-a-uuid', 'single', [a1])).status).toBe(404);
      expect(await active(id)).toEqual([a1]);
      await adminCall('POST', `/cashier-accounts/${id}/revoke`);
      expect((await assign(id, 'single', [a2])).error?.code).toBe('CASHIER_ACCOUNT_REVOKED');
      expect(await active(id)).toEqual([a1]);
    });

    it('requires cashier:manage, business-wide access and a fresh proof; a Manager is denied; an Admin may assign', async () => {
      const made = await create('auth1', 'single', [a1]);
      const id = made.data.account.id as string;
      const body = { accessMode: 'single', branchIds: [a2] };
      expect((await http('PUT', `/cashier-accounts/${id}/branches`, { token: tok.ownerA!, businessId: bizA, body })).error?.code).toBe('REAUTH_REQUIRED');
      expect([401, 403]).toContain((await http('PUT', `/cashier-accounts/${id}/branches`, { businessId: bizA, body })).status);
      const proof = (await http('POST', '/cashier-accounts/reauth', { token: tok.adminA!, businessId: bizA, body: { password: PW } })).data.proof;
      const managerAttempt = await http('PUT', `/cashier-accounts/${id}/branches`, { token: tok.managerA!, businessId: bizA, headers: { 'X-Reauth-Proof': proof }, body });
      expect(managerAttempt.status).toBe(403);
      expect(await active(id)).toEqual([a1]);
      const adminOk = await assign(id, 'single', [a2], 'adminA');
      expect(adminOk.status, JSON.stringify(adminOk)).toBe(200);
      expect(await active(id)).toEqual([a2]);
    });

    it("business B's owner cannot change business A's cashier, and a cashier session cannot change anything", async () => {
      const made = await create('iso1', 'single', [a1]);
      const id = made.data.account.id as string;
      expect((await assign(id, 'single', [b1], 'ownerB')).error?.code).toBe('CASHIER_ACCOUNT_NOT_FOUND');
      expect(await active(id)).toEqual([a1]);
      const cashierToken = (await signIn('iso1')).data.accessToken as string;
      const res = await http('PUT', `/cashier-accounts/${id}/branches`, { token: cashierToken, businessId: bizA, body: { accessMode: 'single', branchIds: [a2] } });
      expect(res.status).toBe(403);
      expect(res.error?.code).toBe('CASHIER_ROUTE_DENIED');
      expect(await active(id)).toEqual([a1]);
    });

    it('concurrent assignment changes serialise: one clean final state, no duplicate or mixed grants', async () => {
      const made = await create('race1', 'single', [a1]);
      const id = made.data.account.id as string;
      const results = await Promise.all([
        assign(id, 'multiple', [a1, a2]), assign(id, 'multiple', [a2, a3]), assign(id, 'single', [a3]), assign(id, 'multiple', [a1, a3]),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r)).toBe(200);
      const final = await active(id);
      expect([[a1, a2], [a2, a3], [a3], [a1, a3]].map((s) => [...s].sort().join())).toContain(final.join());
      const dupes = await q(`SELECT branch_id, count(*)::int n FROM user_business_roles WHERE user_id = $1 AND deleted_at IS NULL GROUP BY branch_id HAVING count(*) > 1`, [id]);
      expect(dupes).toHaveLength(0);
      const list = await http('GET', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA });
      const row = list.data.find((a: { id: string }) => a.id === id);
      expect(row.branches.map((b: { id: string }) => b.id).sort()).toEqual(final);
      expect(row.accessMode).toBe(final.length === 1 ? 'single' : 'multiple');
    });

    it('the database still forbids a business-wide, wrong-role or wrong-business grant for a managed cashier', async () => {
      const id = (await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'multi1'`, [bizA]))[0].id as string;
      const role = (await q(`SELECT id FROM roles WHERE business_id = $1 AND name = 'Cashier'`, [bizA]))[0].id as string;
      const ins = `INSERT INTO user_business_roles (user_id, business_id, branch_id, role_id) VALUES ($1,$2,$3,$4)`;
      await expect(client.query(ins, [id, bizA, null, role])).rejects.toThrow(/MANAGED_CASHIER_GRANT_REQUIRES_BRANCH/);
      await expect(client.query(ins, [id, bizA, b1, role])).rejects.toThrow(/MANAGED_CASHIER_GRANT_WRONG_BRANCH/);
    });
  });

  describe('the list reports status, branches and mode', () => {
    it('shows each account with its assignment and never any credential', async () => {
      const list = await http('GET', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA });
      expect(list.status).toBe(200);
      const multi = list.data.find((a: { username: string }) => a.username === 'multi1');
      expect(multi).toMatchObject({ accessMode: 'multiple', status: 'active' });
      expect(multi.branches.map((b: { name: string }) => b.name).sort()).toEqual(['A1', 'A3']);
      expect(JSON.stringify(list.data)).not.toMatch(/password|hash/i);
      const listB = await http('GET', '/cashier-accounts', { token: tok.ownerB!, businessId: bizB });
      expect(listB.data).toEqual([]);
    });
  });
});
