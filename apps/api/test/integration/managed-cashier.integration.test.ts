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
import { cashierAccountRoutes } from '../../src/cashier-accounts/cashier-accounts.routes';
import { cashierSessionRoutes } from '../../src/cashier-sessions/cashier-sessions.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';
import { CashierAuthService } from '../../src/auth/cashier-auth.service';
import type { Pbkdf2Worker } from '../../src/auth/pbkdf2-worker';

/**
 * CASHIER-AUTH-02A against REAL Postgres and the REAL middleware stack (audit, cashier scope guard, authenticate, tenant
 * context, permissions, rate-limit wiring). Hashing runs at 1,000 iterations through a stand-in for the hasher Durable Object so
 * the suite is fast; the service still asks for its production iteration count and the verification path is unchanged.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('Managed cashier tests need a loopback PostgreSQL database.');
}

const SECRET = 'managed-cashier-fixture-access-secret';
const REFRESH_SECRET = 'managed-cashier-fixture-refresh-secret';
const run = randomUUID();
const allow = { limit: async () => ({ success: true }) };
const FAST_ITERATIONS = 1000;
const fastHasher: Pbkdf2Worker = {
  hash: (input) => pbkdf2Hash(input, FAST_ITERATIONS),
  verify: (input, stored) => pbkdf2Verify(input, stored),
};
/** The hasher Durable Object stand-in the routes call through `PASSWORD_HASHER`. */
const hasherNamespace = {
  newUniqueId: () => ({}),
  get: () => ({
    fetch: async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { action: string; input: string; storedHash?: string };
      const result = body.action === 'hash' ? await pbkdf2Hash(body.input, FAST_ITERATIONS) : await pbkdf2Verify(body.input, body.storedHash ?? '');
      return Response.json({ result });
    },
  }),
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/cashier-accounts', cashierAccountRoutes);
app.route('/api/v1/cashier-sessions', cashierSessionRoutes);
app.onError(errorHandler);

// The response envelope is asserted field by field across many shapes; a loose test-only type keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
interface Call { token?: string; businessId?: string; body?: unknown; headers?: Record<string, string> }

async function http(method: string, path: string, call: Call = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers(call.headers);
  if (call.token) headers.set('Authorization', `Bearer ${call.token}`);
  if (call.businessId) headers.set('X-Business-Id', call.businessId);
  if (call.body !== undefined) headers.set('Content-Type', 'application/json');
  const env = {
    HYPERDRIVE: { connectionString: databaseUrl },
    JWT_ACCESS_SECRET: SECRET,
    JWT_REFRESH_SECRET: REFRESH_SECRET,
    PASSWORD_HASHER: hasherNamespace,
    AUTH_RATE_LIMITER: allow,
    API_RATE_LIMITER: allow,
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, {
    method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  return { status: response.status, ...(text ? (JSON.parse(text) as Envelope) : {}) };
}

describe.skipIf(!databaseUrl)('CASHIER-AUTH-02A managed cashier identity (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;

  let bizA: string; let bizB: string;
  let a1: string; let a2: string; let b1: string;
  let ownerA: string; let adminA: string; let managerA: string; let staffA: string; let branchAdminA: string; let ownerB: string;
  const tok: Record<string, string> = {};
  let managerRoleId: string;
  let codeA = '';
  let codeB = '';

  const user = async (label: string, password = 'a-regular-staff-password') => (await repos.users.create({
    email: `mc-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash(password, FAST_ITERATIONS), status: 'active',
  })).id;

  /** Re-authenticates as an administrator and returns the proof header set. */
  const reauth = async (who: 'ownerA' | 'adminA' | 'ownerB', businessId: string, password = 'a-regular-staff-password') => {
    const res = await http('POST', '/cashier-accounts/reauth', { token: tok[who]!, businessId, body: { password } });
    expect(res.status, JSON.stringify(res)).toBe(200);
    return { 'X-Reauth-Proof': res.data.proof as string };
  };
  const adminCall = async (method: string, path: string, body?: unknown, who: 'ownerA' | 'adminA' | 'ownerB' = 'ownerA') => {
    const businessId = who === 'ownerB' ? bizB : bizA;
    return http(method, path, { token: tok[who]!, businessId, headers: await reauth(who, businessId), ...(body === undefined ? {} : { body }) });
  };

  const create = async (username: string, branchId: string, extra: Record<string, unknown> = {}, who: 'ownerA' | 'adminA' | 'ownerB' = 'ownerA') =>
    adminCall('POST', '/cashier-accounts', { username, displayName: `Till ${username}`, branchId, ...extra }, who);
  const signIn = (businessCode: string, username: string, password: string, deviceLabel?: string) =>
    http('POST', '/auth/cashier/managed-login', { body: { businessCode, username, password, ...(deviceLabel ? { deviceLabel } : {}) } });
  const GENERIC = { status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid sign-in details.' };
  const outcome = (r: { status: number } & Envelope) => ({ status: r.status, code: r.error?.code, message: r.error?.message });

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const db = buildDb(client);
    repos = createRepositories(db);
    ownerA = await user('owner-a'); adminA = await user('admin-a'); managerA = await user('manager-a');
    staffA = await user('staff-a'); branchAdminA = await user('branch-admin-a'); ownerB = await user('owner-b');
    bizA = (await repos.businesses.create({ name: 'Managed A', slug: `mc-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: 'Managed B', slug: `mc-b-${run}` })).id;
    a1 = (await repos.branches.create({ businessId: bizA, name: 'A1', slug: 'a1' })).id;
    a2 = (await repos.branches.create({ businessId: bizA, name: 'A2', slug: 'a2' })).id;
    b1 = (await repos.branches.create({ businessId: bizB, name: 'B1', slug: 'b1' })).id;
    const provisioning = new RoleProvisioningService(repos);
    const rolesA = await provisioning.seedDefaultRoles(bizA, ownerA);
    const rolesB = await provisioning.seedDefaultRoles(bizB, ownerB);
    managerRoleId = rolesA.Manager;
    const grant = (userId: string, businessId: string, roleId: string, branchId: string | null) =>
      repos.userBusinessRoles.grant({ userId, businessId, branchId, roleId, createdBy: userId });
    await grant(ownerA, bizA, rolesA.Owner, null);
    await grant(adminA, bizA, rolesA.Admin, null);
    await grant(managerA, bizA, rolesA.Manager, null);
    await grant(staffA, bizA, rolesA.Staff, a1);
    await grant(branchAdminA, bizA, rolesA.Admin, a1);
    await grant(ownerB, bizB, rolesB.Owner, null);
    for (const [key, id] of Object.entries({ ownerA, adminA, managerA, staffA, branchAdminA, ownerB })) tok[key] = await signAccessToken(id, SECRET);
  });
  afterAll(async () => { await client?.end(); });

  describe('administration authorization (D-4)', () => {
    it('cashier:manage is in the catalog and defaults to Owner and Admin only', async () => {
      const keys = async (id: string, biz: string, branch?: string) => repos.permissions.findEffectiveKeys(id, biz, branch);
      expect((await repos.permissions.listAll()).map((p) => p.key)).toContain('cashier:manage');
      expect((await keys(ownerA, bizA)).has('cashier:manage')).toBe(true);
      expect((await keys(adminA, bizA)).has('cashier:manage')).toBe(true);
      expect((await keys(managerA, bizA)).has('cashier:manage')).toBe(false);
      expect((await keys(staffA, bizA, a1)).has('cashier:manage')).toBe(false);
    });

    it('refuses a Manager, a branch-scoped Admin, a Staff user, a foreign owner and an anonymous caller (server-side)', async () => {
      const attempts: [string, { status: number } & Envelope][] = [
        ['manager list', await http('GET', '/cashier-accounts', { token: tok.managerA!, businessId: bizA })],
        ['staff list', await http('GET', '/cashier-accounts', { token: tok.staffA!, businessId: bizA })],
        ['branch-scoped admin list', await http('GET', '/cashier-accounts', { token: tok.branchAdminA!, businessId: bizA })],
        ['foreign owner list', await http('GET', '/cashier-accounts', { token: tok.ownerB!, businessId: bizA })],
        ['anonymous list', await http('GET', '/cashier-accounts', { businessId: bizA })],
        ['manager reauth', await http('POST', '/cashier-accounts/reauth', { token: tok.managerA!, businessId: bizA, body: { password: 'a-regular-staff-password' } })],
      ];
      for (const [label, res] of attempts) expect([401, 403], `${label}: ${res.status}`).toContain(res.status);
      expect(await q(`SELECT 1 FROM users WHERE managed_business_id = $1`, [bizA])).toHaveLength(0);
    });

    it('a Manager can administer only after the Owner explicitly grants cashier:manage to the Manager role', async () => {
      const permissionId = (await q(`SELECT id FROM permissions WHERE key = 'cashier:manage'`))[0].id;
      await q(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)`, [managerRoleId, permissionId]);
      try {
        const list = await http('GET', '/cashier-accounts', { token: tok.managerA!, businessId: bizA });
        expect(list.status).toBe(200);
      } finally {
        await q(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [managerRoleId, permissionId]);
      }
      expect((await http('GET', '/cashier-accounts', { token: tok.managerA!, businessId: bizA })).status).toBe(403);
    });
  });

  describe('fresh administrator re-authentication (D-5)', () => {
    it('refuses a mutation without a proof, with a wrong password, with an expired proof, and with another administrator or business proof', async () => {
      const noProof = await http('POST', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA, body: { username: 'noproof', displayName: 'x', branchId: a1 } });
      expect(noProof.status).toBe(403);
      expect(noProof.error?.code).toBe('REAUTH_REQUIRED');
      const wrong = await http('POST', '/cashier-accounts/reauth', { token: tok.ownerA!, businessId: bizA, body: { password: 'not-the-password' } });
      expect(wrong.status).toBe(401);
      const adminProof = await reauth('adminA', bizA);
      const crossAdmin = await http('POST', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA, headers: adminProof, body: { username: 'crossproof', displayName: 'x', branchId: a1 } });
      expect(crossAdmin.error?.code).toBe('REAUTH_REQUIRED');
      const { signAdminReauthProof } = await import('../../src/cashier-accounts/credentials');
      const otherBiz = await signAdminReauthProof(ownerA, bizB, SECRET);
      expect((await http('POST', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA, headers: { 'X-Reauth-Proof': otherBiz.proof }, body: { username: 'crossbiz', displayName: 'x', branchId: a1 } })).error?.code).toBe('REAUTH_REQUIRED');
      // An access token is not a proof, and a proof is not an access token.
      expect((await http('POST', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA, headers: { 'X-Reauth-Proof': tok.ownerA! }, body: { username: 'tokenproof', displayName: 'x', branchId: a1 } })).error?.code).toBe('REAUTH_REQUIRED');
      expect((await http('GET', '/auth/me', { token: otherBiz.proof })).status).toBe(401);
      // Expired: a proof whose exp is in the past.
      const { sign } = await import('hono/jwt');
      const iat = Math.floor(Date.now() / 1000) - 600;
      const expired = await sign({ sub: ownerA, biz: bizA, type: 'cashier_admin_reauth', iat, exp: iat + 300 }, SECRET, 'HS256');
      expect((await http('POST', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA, headers: { 'X-Reauth-Proof': expired }, body: { username: 'expired1', displayName: 'x', branchId: a1 } })).error?.code).toBe('REAUTH_REQUIRED');
      expect(await q(`SELECT 1 FROM users WHERE managed_business_id = $1 AND login_username IN ('noproof','crossproof','crossbiz','tokenproof','expired1')`, [bizA])).toHaveLength(0);
    });
  });

  describe('account creation and namespace (D-1, D-3)', () => {
    let tillPassword = '';
    it('creates an email-less managed identity bound to one business and one branch with only the Cashier role', async () => {
      const res = await create('till1', a1);
      expect(res.status, JSON.stringify(res)).toBe(201);
      tillPassword = res.data.initialPassword;
      expect(tillPassword).toHaveLength(24);
      codeA = res.data.cashierCode;
      expect(codeA).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
      const row = (await q(`SELECT * FROM users WHERE id = $1`, [res.data.account.id]))[0];
      expect(row.email).toBeNull();
      expect(row.managed_business_id).toBe(bizA);
      expect(row.login_username).toBe('till1');
      expect(row.managed_by_user_id).toBe(ownerA);
      expect(row.password_hash).not.toContain(tillPassword);
      expect(row.password_hash.startsWith('pbkdf2$')).toBe(true);
      const grants = await q(`SELECT r.name, r.is_system, ubr.branch_id, ubr.business_id FROM user_business_roles ubr JOIN roles r ON r.id = ubr.role_id WHERE ubr.user_id = $1 AND ubr.deleted_at IS NULL`, [row.id]);
      expect(grants).toEqual([{ name: 'Cashier', is_system: true, branch_id: a1, business_id: bizA }]);
      const perms = await repos.permissions.findEffectiveKeys(row.id, bizA, a1);
      expect([...perms].sort()).toEqual(['branches:view', 'business:view', 'loyalty:serve']);
    });

    it('never writes the credential to the audit log, and audits creation', async () => {
      const audit = await q(`SELECT action, metadata::text AS m FROM audit_log WHERE business_id = $1 AND action LIKE 'cashier_account.%'`, [bizA]);
      expect(audit.map((a) => a.action)).toContain('cashier_account.created');
      for (const a of audit) expect(a.m).not.toContain(tillPassword);
    });

    it('the same username can exist in two businesses; within one business it collides, case-insensitively', async () => {
      const inB = await create('till1', b1, {}, 'ownerB');
      expect(inB.status, JSON.stringify(inB)).toBe(201);
      codeB = inB.data.cashierCode;
      expect(codeB).not.toBe(codeA);
      expect((await create('till1', a2)).error?.code).toBe('CASHIER_USERNAME_TAKEN');
      expect((await create('  TILL1 ', a2)).error?.code).toBe('CASHIER_USERNAME_TAKEN');
      expect((await create('ab', a1)).error?.code).toBe('CASHIER_USERNAME_INVALID');
      expect((await create('bad name!', a1)).error?.code).toBe('CASHIER_USERNAME_INVALID');
      expect((await create('shortpw', a1, { password: 'short' })).error?.code).toBe('CASHIER_PASSWORD_INVALID');
    });

    it('rejects a branch of another business and an unknown branch', async () => {
      expect((await create('wrongbranch', b1)).error?.code).toBe('CASHIER_BRANCH_NOT_FOUND');
      expect((await create('nobranch', randomUUID())).error?.code).toBe('CASHIER_BRANCH_NOT_FOUND');
    });

    it('an administrator-supplied password (minimum 8) is accepted and never echoed', async () => {
      const res = await create('supplied1', a1, { password: 'eightchr' });
      expect(res.status).toBe(201);
      expect(res.data.initialPassword).toBeNull();
      expect((await signIn(codeA, 'supplied1', 'eightchr')).status).toBe(200);
    });

    it('lists only this business accounts, with no hash or credential field', async () => {
      const listA = await http('GET', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA });
      expect(listA.status).toBe(200);
      expect(listA.data.map((a: { username: string }) => a.username)).toEqual(expect.arrayContaining(['till1', 'supplied1']));
      const listB = await http('GET', '/cashier-accounts', { token: tok.ownerB!, businessId: bizB });
      expect(listB.data.map((a: { username: string }) => a.username)).toEqual(['till1']);
      expect(JSON.stringify(listA.data)).not.toMatch(/password|hash/i);
    });
  });

  describe('sign-in, namespace resolution and enumeration resistance (D-3)', () => {
    it('signs in with business code, username and password; the session is bound to that business and branch', async () => {
      const list = await http('GET', '/cashier-accounts', { token: tok.ownerA!, businessId: bizA });
      const till = list.data.find((a: { username: string }) => a.username === 'till1');
      const reset = await adminCall('POST', `/cashier-accounts/${till.id}/reset-credential`, {});
      const password = reset.data.initialPassword as string;
      const res = await signIn(codeA.toLowerCase().replace(/(.{5})/, '$1-'), ' Till1 ', password, 'Counter 1');
      expect(res.status, JSON.stringify(res)).toBe(200);
      expect(res.data.status).toBe('authenticated');
      expect(res.data.session).toMatchObject({ businessId: bizA, branchId: a1, deviceLabel: 'Counter 1' });
      expect(JSON.stringify(res)).not.toMatch(/passwordHash|password_hash/);
      const me = await http('GET', '/auth/me', { token: res.data.accessToken, businessId: bizA });
      expect(me.status).toBe(200);
      expect(me.data.email).toBeNull();
    });

    it('answers every failure identically: wrong password, unknown username, unknown code, wrong business code, malformed input', async () => {
      const wrongPassword = outcome(await signIn(codeA, 'till1', 'definitely-wrong'));
      expect(wrongPassword).toEqual(GENERIC);
      const results = [
        outcome(await signIn(codeA, 'no-such-user', 'definitely-wrong')),
        outcome(await signIn('ZZZZZZZZZZ', 'till1', 'definitely-wrong')),
        outcome(await signIn(codeB, 'supplied1', 'eightchr')), // right credentials, wrong business's code
        outcome(await signIn('not a code', 'till1', 'definitely-wrong')),
        outcome(await signIn(codeA, '!!', 'definitely-wrong')),
      ];
      for (const r of results) expect(r).toEqual(GENERIC);
    });

    it('business-code confusion: the same username signs into the business its code names, each with its own credential', async () => {
      const resetB = await adminCall('POST', `/cashier-accounts/${(await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'till1'`, [bizB]))[0].id}/reset-credential`, {}, 'ownerB');
      const inB = await signIn(codeB, 'till1', resetB.data.initialPassword);
      expect(inB.status).toBe(200);
      expect(inB.data.session.businessId).toBe(bizB);
      // B's credential never works against A's code, even though the username matches.
      expect(outcome(await signIn(codeA, 'till1', resetB.data.initialPassword))).toEqual(GENERIC);
    });

    it('rotating the business code stops the old code and starts the new one', async () => {
      const before = await http('GET', '/cashier-accounts/business-code', { token: tok.ownerA!, businessId: bizA });
      expect(before.data.cashierCode).toBe(codeA);
      const rotated = await adminCall('POST', '/cashier-accounts/business-code/rotate');
      expect(rotated.status).toBe(200);
      const newCode = rotated.data.cashierCode as string;
      expect(newCode).not.toBe(codeA);
      expect(outcome(await signIn(codeA, 'supplied1', 'eightchr'))).toEqual(GENERIC);
      expect((await signIn(newCode, 'supplied1', 'eightchr')).status).toBe(200);
      codeA = newCode;
      expect(await q(`SELECT 1 FROM audit_log WHERE business_id = $1 AND action = 'cashier_code.rotated'`, [bizA])).toHaveLength(1);
    });

    it('a managed identity cannot use ordinary web sign-in, email cashier sign-in, password reset or self password change', async () => {
      const id = (await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'supplied1'`, [bizA]))[0].id;
      // No email exists to match, so the email flows cannot reach it.
      expect((await http('POST', '/auth/login', { body: { email: 'supplied1@example.test', password: 'eightchr' } })).status).toBe(401);
      expect((await http('POST', '/auth/cashier/login', { body: { email: 'supplied1@example.test', password: 'eightchr' } })).status).toBe(401);
      expect((await http('POST', '/auth/password-reset/request', { body: { email: 'supplied1@example.test' } })).status).toBe(202);
      // Even a validly signed ordinary token for the managed id cannot change its own credential.
      const webToken = await signAccessToken(id, SECRET);
      const change = await http('POST', '/auth/password/change', { token: webToken, body: { currentPassword: 'eightchr', newPassword: 'a-brand-new-password' } });
      expect(change.status).toBe(401);
      expect(outcome(await signIn(codeA, 'supplied1', 'a-brand-new-password'))).toEqual(GENERIC);
      expect((await signIn(codeA, 'supplied1', 'eightchr')).status).toBe(200);
      // A forged reset token row cannot redeem either.
      const tokenHash = 'f'.repeat(64);
      await q(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [id, tokenHash]);
      expect((await http('POST', '/auth/password-reset/confirm', { body: { token: 'f'.repeat(43), newPassword: 'another-new-password' } })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('a managed cashier session reaches only the eight allow-listed routes', () => {
    it('denies administration, credential reset, settings and session management with CASHIER_ROUTE_DENIED', async () => {
      const id = (await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'supplied1'`, [bizA]))[0].id;
      const session = await signIn(codeA, 'supplied1', 'eightchr');
      const token = session.data.accessToken as string;
      const targets: [string, string][] = [
        ['GET', '/cashier-accounts'], ['POST', '/cashier-accounts/reauth'], ['POST', '/cashier-accounts'],
        ['POST', `/cashier-accounts/${id}/reset-credential`], ['PATCH', `/cashier-accounts/${id}/username`],
        ['POST', `/cashier-accounts/${id}/disable`], ['GET', '/cashier-sessions'], ['POST', '/cashier-sessions/revoke-all'],
        ['PATCH', '/auth/me'], ['POST', '/auth/password/change'],
      ];
      for (const [method, path] of targets) {
        const res = await http(method, path, { token, businessId: bizA, ...(method === 'GET' ? {} : { body: {} }) });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.error?.code, `${method} ${path}`).toBe('CASHIER_ROUTE_DENIED');
      }
    });
  });

  describe('lockout (D-5)', () => {
    const lockRow = async (username: string) => (await q(`SELECT failed_login_count AS n, failed_login_window_started_at AS w, locked_until AS l FROM users WHERE managed_business_id = $1 AND login_username = $2`, [bizA, username]))[0];

    it('five failures lock the identity: even the right password then fails with the same generic error', async () => {
      await create('lock1', a1, { password: 'correct-horse-1' });
      for (let i = 0; i < 4; i++) expect(outcome(await signIn(codeA, 'lock1', 'wrong-guess'))).toEqual(GENERIC);
      expect((await lockRow('lock1')).l).toBeNull();
      expect(outcome(await signIn(codeA, 'lock1', 'wrong-guess'))).toEqual(GENERIC);
      const locked = await lockRow('lock1');
      expect(locked.n).toBe(5);
      expect(locked.l).not.toBeNull();
      const minutes = (new Date(locked.l).getTime() - Date.now()) / 60000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);
      expect(outcome(await signIn(codeA, 'lock1', 'correct-horse-1'))).toEqual(GENERIC);
    });

    it('failures while locked do not extend the lock (deliberate-lockout abuse is bounded)', async () => {
      const before = await lockRow('lock1');
      for (let i = 0; i < 3; i++) await signIn(codeA, 'lock1', 'still-wrong');
      const after = await lockRow('lock1');
      expect(new Date(after.l).getTime()).toBe(new Date(before.l).getTime());
      expect(after.n).toBe(before.n);
    });

    it('the lock lapses after fifteen minutes and a correct password then clears the counters', async () => {
      await q(`UPDATE users SET locked_until = now() - interval '1 second', failed_login_window_started_at = now() - interval '16 minutes' WHERE managed_business_id = $1 AND login_username = 'lock1'`, [bizA]);
      expect((await signIn(codeA, 'lock1', 'correct-horse-1')).status).toBe(200);
      expect(await lockRow('lock1')).toMatchObject({ n: 0, w: null, l: null });
    });

    it('failures older than the 15 minute window start a new count; a success resets the count', async () => {
      await create('window1', a1, { password: 'correct-horse-2' });
      for (let i = 0; i < 4; i++) await signIn(codeA, 'window1', 'nope');
      expect((await lockRow('window1')).n).toBe(4);
      await q(`UPDATE users SET failed_login_window_started_at = now() - interval '16 minutes' WHERE managed_business_id = $1 AND login_username = 'window1'`, [bizA]);
      await signIn(codeA, 'window1', 'nope');
      const restarted = await lockRow('window1');
      expect(restarted.n).toBe(1);
      expect(restarted.l).toBeNull();
      expect((await signIn(codeA, 'window1', 'correct-horse-2')).status).toBe(200);
      expect((await lockRow('window1')).n).toBe(0);
    });

    it('concurrent failures are counted atomically and still reach the lock', async () => {
      await create('race1', a1, { password: 'correct-horse-3' });
      await Promise.all(Array.from({ length: 5 }, () => signIn(codeA, 'race1', 'nope')));
      const row = await lockRow('race1');
      expect(row.n).toBe(5);
      expect(row.l).not.toBeNull();
    });

    it('an unknown or foreign identity cannot be locked by guessing (no row to update, same answer)', async () => {
      for (let i = 0; i < 6; i++) expect(outcome(await signIn(codeA, 'ghost-user', 'nope'))).toEqual(GENERIC);
      expect(await q(`SELECT 1 FROM users WHERE login_username = 'ghost-user'`)).toHaveLength(0);
    });
  });

  describe('credential lifecycle, status and revocation (D-5)', () => {
    let id = '';
    let password = 'lifecycle-pass-1';
    let session: { accessToken: string; refreshToken: string };
    beforeAll(async () => {
      const res = await create('life1', a1, { password });
      id = res.data.account.id;
      const s = await signIn(codeA, 'life1', password);
      session = s.data;
    });

    it('a reset returns a new one-time credential, voids the old one, revokes live sessions and clears a lock', async () => {
      await q(`UPDATE users SET failed_login_count = 3, locked_until = now() + interval '10 minutes' WHERE id = $1`, [id]);
      const reset = await adminCall('POST', `/cashier-accounts/${id}/reset-credential`, {});
      expect(reset.status).toBe(200);
      const fresh = reset.data.initialPassword as string;
      expect(fresh).toHaveLength(24);
      expect(fresh).not.toBe(password);
      expect(outcome(await signIn(codeA, 'life1', password))).toEqual(GENERIC);
      // The pre-reset session is dead at once: the access token, and the refresh token.
      expect((await http('GET', '/auth/me', { token: session.accessToken })).status).toBe(401);
      expect((await http('POST', '/auth/cashier/refresh', { body: { refreshToken: session.refreshToken } })).status).toBe(401);
      expect((await signIn(codeA, 'life1', fresh)).status).toBe(200);
      expect((await q(`SELECT failed_login_count AS n FROM users WHERE id = $1`, [id]))[0].n).toBe(0);
      password = fresh;
      const audit = await q(`SELECT metadata::text AS m FROM audit_log WHERE entity_id = $1 AND action = 'cashier_account.credential_reset'`, [id]);
      expect(audit).toHaveLength(1);
      expect(audit[0].m).not.toContain(fresh);
    });

    it('disabling revokes sessions immediately and blocks sign-in; enabling restores it; revoking is terminal', async () => {
      const live = (await signIn(codeA, 'life1', password)).data;
      expect((await adminCall('POST', `/cashier-accounts/${id}/disable`)).data.status).toBe('disabled');
      expect((await http('GET', '/auth/me', { token: live.accessToken })).status).toBe(401);
      expect((await http('POST', '/auth/cashier/refresh', { body: { refreshToken: live.refreshToken } })).status).toBeGreaterThanOrEqual(401);
      expect(outcome(await signIn(codeA, 'life1', password))).toEqual(GENERIC);
      expect((await adminCall('POST', `/cashier-accounts/${id}/disable`)).error?.code).toBe('CASHIER_ACCOUNT_STATE_CONFLICT');
      expect((await adminCall('POST', `/cashier-accounts/${id}/enable`)).data.status).toBe('active');
      expect((await signIn(codeA, 'life1', password)).status).toBe(200);
      expect((await adminCall('POST', `/cashier-accounts/${id}/revoke`)).data.status).toBe('revoked');
      expect(outcome(await signIn(codeA, 'life1', password))).toEqual(GENERIC);
      expect((await adminCall('POST', `/cashier-accounts/${id}/enable`)).error?.code).toBe('CASHIER_ACCOUNT_STATE_CONFLICT');
      expect((await adminCall('POST', `/cashier-accounts/${id}/reset-credential`, {})).error?.code).toBe('CASHIER_ACCOUNT_STATE_CONFLICT');
      expect((await adminCall('PATCH', `/cashier-accounts/${id}/username`, { username: 'life1-renamed' })).error?.code).toBe('CASHIER_ACCOUNT_REVOKED');
    });

    it('revoking sessions ends them without disabling the account', async () => {
      const r = await create('life2', a1, { password: 'lifecycle-pass-2' });
      const s = (await signIn(codeA, 'life2', 'lifecycle-pass-2')).data;
      const revoked = await adminCall('POST', `/cashier-accounts/${r.data.account.id}/revoke-sessions`);
      expect(revoked.data.revoked).toBeGreaterThan(0);
      expect((await http('GET', '/auth/me', { token: s.accessToken })).status).toBe(401);
      expect((await signIn(codeA, 'life2', 'lifecycle-pass-2')).status).toBe(200);
    });

    it('renaming changes the sign-in name, keeps the account, and collides within the business only', async () => {
      const r = await create('rename1', a1, { password: 'lifecycle-pass-3' });
      expect((await adminCall('PATCH', `/cashier-accounts/${r.data.account.id}/username`, { username: 'till1' })).error?.code).toBe('CASHIER_USERNAME_TAKEN');
      expect((await adminCall('PATCH', `/cashier-accounts/${r.data.account.id}/username`, { username: 'rename2' })).data.username).toBe('rename2');
      expect(outcome(await signIn(codeA, 'rename1', 'lifecycle-pass-3'))).toEqual(GENERIC);
      expect((await signIn(codeA, 'rename2', 'lifecycle-pass-3')).status).toBe(200);
    });

    it('concurrent identical status changes resolve to exactly one success', async () => {
      const r = await create('race2', a1, { password: 'lifecycle-pass-4' });
      const a = await adminCall('POST', `/cashier-accounts/${r.data.account.id}/disable`);
      expect(a.status).toBe(200);
      const [x, y] = await Promise.all([
        adminCall('POST', `/cashier-accounts/${r.data.account.id}/enable`),
        adminCall('POST', `/cashier-accounts/${r.data.account.id}/enable`),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    });
  });

  describe('tenant isolation of administration', () => {
    it("business B's owner cannot read, reset, rename, disable or revoke business A's cashier; nothing changes", async () => {
      const target = (await q(`SELECT id, password_hash, status, login_username FROM users WHERE managed_business_id = $1 AND login_username = 'supplied1'`, [bizA]))[0];
      for (const [method, path, body] of [
        ['POST', `/cashier-accounts/${target.id}/reset-credential`, {}],
        ['PATCH', `/cashier-accounts/${target.id}/username`, { username: 'hijacked' }],
        ['POST', `/cashier-accounts/${target.id}/disable`, undefined],
        ['POST', `/cashier-accounts/${target.id}/revoke`, undefined],
        ['POST', `/cashier-accounts/${target.id}/revoke-sessions`, undefined],
      ] as const) {
        const res = await adminCall(method, path, body, 'ownerB');
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.error?.code).toBe('CASHIER_ACCOUNT_NOT_FOUND');
      }
      const after = (await q(`SELECT id, password_hash, status, login_username FROM users WHERE id = $1`, [target.id]))[0];
      expect(after).toEqual(target);
      const listB = await http('GET', '/cashier-accounts', { token: tok.ownerB!, businessId: bizB });
      expect(listB.data.map((a: { id: string }) => a.id)).not.toContain(target.id);
      expect((await adminCall('POST', `/cashier-accounts/not-a-uuid/disable`)).status).toBe(404);
    });

    it("a Cashier cannot create a branch grant in another business's branch, and cannot hold another role, even by direct SQL", async () => {
      const id = (await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'supplied1'`, [bizA]))[0].id;
      const owner = (await q(`SELECT id FROM roles WHERE business_id = $1 AND name = 'Owner'`, [bizA]))[0].id;
      const cashierRole = (await q(`SELECT id FROM roles WHERE business_id = $1 AND name = 'Cashier'`, [bizA]))[0].id;
      const fails = async (sql: string, values: unknown[], match: RegExp) => { await expect(client.query(sql, values)).rejects.toThrow(match); };
      const ins = `INSERT INTO user_business_roles (user_id, business_id, branch_id, role_id) VALUES ($1,$2,$3,$4)`;
      await fails(ins, [id, bizA, a2, owner], /MANAGED_CASHIER_ROLE_RESTRICTED/);
      await fails(ins, [id, bizA, null, cashierRole], /MANAGED_CASHIER_GRANT_REQUIRES_BRANCH/);
      await fails(ins, [id, bizB, b1, cashierRole], /MANAGED_CASHIER_GRANT_WRONG_BUSINESS/);
      await fails(ins, [id, bizA, b1, cashierRole], /MANAGED_CASHIER_GRANT_WRONG_BRANCH/);
      const otherBusinessCashierRole = (await q(`SELECT id FROM roles WHERE business_id = $1 AND name = 'Cashier'`, [bizB]))[0].id;
      await fails(ins, [id, bizA, a2, otherBusinessCashierRole], /MANAGED_CASHIER_ROLE_RESTRICTED/);
    });
  });

  describe('database constraints (D-1)', () => {
    const fails = async (sql: string, values: unknown[], match: RegExp) => { await expect(client.query(sql, values)).rejects.toThrow(match); };
    it('a managed row can never gain an email, a platform role or another business; an ordinary row can never become managed', async () => {
      const id = (await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'supplied1'`, [bizA]))[0].id;
      await fails(`UPDATE users SET email = 'x@example.test' WHERE id = $1`, [id], /users_managed_shape_check/);
      await fails(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [id], /users_managed_shape_check/);
      await fails(`UPDATE users SET managed_business_id = $2 WHERE id = $1`, [id, bizB], /MANAGED_IDENTITY_BINDING_IMMUTABLE/);
      await fails(`UPDATE users SET managed_business_id = NULL, email = 'x@example.test' WHERE id = $1`, [id], /MANAGED_IDENTITY_BINDING_IMMUTABLE/);
      await fails(`UPDATE users SET managed_business_id = $2, login_username = 'sneaky', managed_by_user_id = $3, email = NULL WHERE id = $1`, [staffA, bizA, ownerA], /MANAGED_IDENTITY_BINDING_IMMUTABLE/);
      await fails(`INSERT INTO users (email, password_hash, full_name, managed_business_id) VALUES ('m@example.test','h','n',$1)`, [bizA], /users_managed_shape_check/);
      await fails(`INSERT INTO users (email, password_hash, full_name) VALUES (NULL,'h','n')`, [], /users_managed_shape_check/);
    });
    it('usernames and business codes are format-checked in the database and unique where they must be', async () => {
      await fails(`INSERT INTO users (password_hash, full_name, managed_business_id, login_username, managed_by_user_id) VALUES ('h','n',$1,'BadName',$2)`, [bizA, ownerA], /users_login_username_check/);
      await fails(`INSERT INTO users (password_hash, full_name, managed_business_id, login_username, managed_by_user_id) VALUES ('h','n',$1,'supplied1',$2)`, [bizA, ownerA], /users_managed_username_key/);
      await fails(`UPDATE businesses SET cashier_code = 'lowercase1' WHERE id = $1`, [bizA], /businesses_cashier_code_check/);
      await fails(`UPDATE businesses SET cashier_code = $2 WHERE id = $1`, [bizB, codeA], /businesses_cashier_code_unique/);
    });
  });

  describe('existing authentication is unchanged (regression)', () => {
    it('ordinary web sign-in still works for an email user', async () => {
      const res = await http('POST', '/auth/login', { body: { email: `mc-owner-a-${run}@example.test`, password: 'a-regular-staff-password' } });
      expect(res.status, JSON.stringify(res)).toBe(200);
      expect(res.data.accessToken).toBeTruthy();
    });
    it('email-based cashier sign-in still works and still refuses a user with no counter permission', async () => {
      const ok = await http('POST', '/auth/cashier/login', { body: { email: `mc-staff-a-${run}@example.test`, password: 'a-regular-staff-password' } });
      expect(ok.status, JSON.stringify(ok)).toBe(200);
      expect(ok.data.session).toMatchObject({ businessId: bizA, branchId: a1 });
      const outsider = await user('no-role');
      const denied = await http('POST', '/auth/cashier/login', { body: { email: `mc-no-role-${run}@example.test`, password: 'a-regular-staff-password' } });
      expect(denied.status).toBe(403);
      expect(outsider).toBeTruthy();
    });
  });

  describe('suspension of the business or removal of the branch grant ends a live managed session', () => {
    it('a suspended business blocks sign-in and the next refresh; a removed branch grant blocks the next refresh', async () => {
      await create('susp1', a1, { password: 'lifecycle-pass-5' });
      const live = (await signIn(codeA, 'susp1', 'lifecycle-pass-5')).data;
      const id = (await q(`SELECT id FROM users WHERE managed_business_id = $1 AND login_username = 'susp1'`, [bizA]))[0].id;
      // Branch grant removed (soft delete): the next refresh is refused and the session ends.
      await q(`UPDATE user_business_roles SET deleted_at = now() WHERE user_id = $1`, [id]);
      const refreshed = await http('POST', '/auth/cashier/refresh', { body: { refreshToken: live.refreshToken } });
      expect(refreshed.status).toBe(403);
      expect(refreshed.error?.code).toBe('CASHIER_ACCESS_REVOKED');
      expect((await http('GET', '/auth/me', { token: live.accessToken })).status).toBe(401);
      expect(outcome(await signIn(codeA, 'susp1', 'lifecycle-pass-5'))).toEqual(GENERIC);

      await create('susp2', a1, { password: 'lifecycle-pass-6' });
      await q(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [bizA]);
      try {
        expect(outcome(await signIn(codeA, 'susp2', 'lifecycle-pass-6'))).toEqual(GENERIC);
      } finally {
        await q(`UPDATE businesses SET status = 'active' WHERE id = $1`, [bizA]);
      }
      expect((await signIn(codeA, 'susp2', 'lifecycle-pass-6')).status).toBe(200);
    });
  });

  describe('replay and stolen tokens', () => {
    it('a rotated refresh token replayed later ends that session; a token from another cashier never refreshes this one', async () => {
      await create('replay1', a1, { password: 'lifecycle-pass-7' });
      const first = (await signIn(codeA, 'replay1', 'lifecycle-pass-7')).data;
      const second = await http('POST', '/auth/cashier/refresh', { body: { refreshToken: first.refreshToken } });
      expect(second.status).toBe(200);
      await new Promise((r) => setTimeout(r, 10_500)); // past the concurrent-rotation grace window
      const replay = await http('POST', '/auth/cashier/refresh', { body: { refreshToken: first.refreshToken } });
      expect(replay.status).toBe(401);
      // The replay burned the whole session: even the legitimately rotated token is dead now.
      expect((await http('POST', '/auth/cashier/refresh', { body: { refreshToken: second.data.refreshToken } })).status).toBe(401);
      expect((await http('GET', '/auth/me', { token: second.data.accessToken })).status).toBe(401);
    }, 30_000);
  });

  describe('constant-cost verification (D-6)', () => {
    it('performs exactly one password verification for every outcome, so timing does not reveal what exists', async () => {
      let calls = 0;
      const spy: Pbkdf2Worker = { hash: fastHasher.hash, verify: async (i, s) => { calls++; return pbkdf2Verify(i, s); } };
      const service = new CashierAuthService(repos, { JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET }, spy);
      const attempts = [
        { businessCode: 'ZZZZZZZZZZ', username: 'till1' },       // unknown code
        { businessCode: 'garbage', username: 'till1' },           // malformed code
        { businessCode: codeA, username: 'ghost-user' },          // unknown user
        { businessCode: codeA, username: '!!' },                  // malformed username
        { businessCode: codeA, username: 'supplied1' },           // real user, wrong password
      ];
      for (const attempt of attempts) {
        calls = 0;
        await expect(service.managedLogin({ ...attempt, password: 'wrong-password' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
        expect(calls, JSON.stringify(attempt)).toBe(1);
      }
    });
  });
});
