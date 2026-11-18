import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
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
import { loyaltyRoutes } from '../../src/loyalty/loyalty.routes';
import { loyaltyCustomerRoutes } from '../../src/loyalty/loyalty-customer.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyRedemptionService } from '../../src/loyalty/loyalty-redemption.service';

/**
 * CASHIER-AUTH-02C against REAL Postgres and the REAL middleware and loyalty services: in-session branch switching for managed
 * multi-branch cashiers. Covers the adversarial matrix (stale and replayed credentials, unassigned and foreign branches,
 * disabled/revoked/locked identities, concurrency, ordering against in-flight purchases and redemptions, rollback on failure,
 * multiple tabs, audit completeness and credential secrecy). Hashing runs at 1,000 iterations through a Durable Object stand-in.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Branch switching tests need a loopback PostgreSQL database.');
}

const SECRET = 'branch-switch-fixture-access-secret';
const REFRESH_SECRET = 'branch-switch-fixture-refresh-secret';
const CUSTOMER_SECRET = 'branch-switch-fixture-customer-secret';
const run = randomUUID();
const allow = { limit: async () => ({ success: true }) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
app.route('/api/v1/loyalty/me', loyaltyCustomerRoutes);
app.route('/api/v1/loyalty', loyaltyRoutes);
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
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET, QR_TOKEN_SECRET: 'branch-switch-lookup-signing-secret',
    PASSWORD_HASHER: hasherNamespace, AUTH_RATE_LIMITER: allow, API_RATE_LIMITER: allow, LOOKUP_RATE_LIMITER: allow,
    PUBLIC_RATE_LIMITER: allow, CUSTOMER_API_RATE_LIMITER: allow, JOBS: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, {
    method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  return { status: response.status, ...(text ? (JSON.parse(text) as Envelope) : {}) };
}

describe.skipIf(!databaseUrl)('CASHIER-AUTH-02C in-session branch switching (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const PW = 'an-owner-password-1';
  let bizA: string; let bizB: string; let a1: string; let a2: string; let a3: string; let b1: string;
  let ownerId: string; let ownerToken: string; let staffEmail: string; let staffWebRefresh: string; let ownerBToken: string;
  let accountA: string; let customerId: string; let customerToken: string; let voucherId: string;
  let code = '';
  const cashierPw = 'cashier-pass-1';
  let seq = 0;

  const proofFor = async () => (await http('POST', '/cashier-accounts/reauth', { token: ownerToken, businessId: bizA, body: { password: PW } })).data.proof as string;
  let cachedProof = '';
  const admin = async (method: string, path: string, body?: unknown) => {
    if (!cachedProof) cachedProof = await proofFor();
    return http(method, path, { token: ownerToken, businessId: bizA, headers: { 'X-Reauth-Proof': cachedProof }, ...(body === undefined ? {} : { body }) });
  };
  const newCashier = async (mode: 'single' | 'multiple', branchIds: string[]) => {
    const username = `sw${run.slice(0, 6)}x${++seq}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const r = await admin('POST', '/cashier-accounts', { username, displayName: `Switch ${username}`, accessMode: mode, branchIds, password: cashierPw });
    expect(r.status, JSON.stringify(r)).toBe(201);
    code = r.data.cashierCode;
    return { id: r.data.account.id as string, username };
  };
  const login = (username: string) => http('POST', '/auth/cashier/managed-login', { body: { businessCode: code, username, password: cashierPw } });
  /** Signs a cashier in and selects a branch, returning the live session credentials. */
  const sessionOn = async (username: string, branchId: string) => {
    const l = await login(username);
    if (l.data?.status === 'authenticated') return l.data as { accessToken: string; refreshToken: string; session: { branchId: string; canSwitchBranch: boolean } };
    const s = await http('POST', '/auth/cashier/session', { body: { ticket: l.data.ticket, businessId: bizA, branchId } });
    expect(s.status, JSON.stringify(s)).toBe(200);
    return s.data as { accessToken: string; refreshToken: string; session: { branchId: string; canSwitchBranch: boolean } };
  };
  const switchTo = (refreshToken: string, branchId: string, fromBranchId?: string) =>
    http('POST', '/auth/cashier/switch-branch', { body: { refreshToken, branchId, ...(fromBranchId ? { fromBranchId } : {}) } });
  const me = (token: string, extra: Partial<Call> = {}) => http('GET', '/businesses/me', { token, ...extra });
  const liveSessions = async (userId: string) => (await q(
    `SELECT session_id, branch_id FROM refresh_tokens WHERE user_id = $1 AND client = 'cashier' AND revoked_at IS NULL AND expires_at > now() ORDER BY issued_at`, [userId]));
  const purchase = (token: string, key: string, branchId?: string) =>
    http('POST', `/loyalty/accounts/${accountA}/purchase`, { token, businessId: bizA, ...(branchId ? { branchId } : {}), body: { purchaseAmount: 10, idempotencyKey: key, channel: 'other' } });

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
    const mkUser = async (label: string) => (await repos.users.create({
      email: `sw-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash(PW, 1000), status: 'active',
    })).id;
    ownerId = await mkUser('owner');
    const ownerBId = await mkUser('ownerb');
    const staffId = await mkUser('staff');
    staffEmail = `sw-staff-${run}@example.test`;
    bizA = (await repos.businesses.create({ name: 'Switch A', slug: `sw-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: 'Switch B', slug: `sw-b-${run}` })).id;
    a1 = (await repos.branches.create({ businessId: bizA, name: 'A1', slug: 'a1' })).id;
    a2 = (await repos.branches.create({ businessId: bizA, name: 'A2', slug: 'a2' })).id;
    a3 = (await repos.branches.create({ businessId: bizA, name: 'A3', slug: 'a3' })).id;
    b1 = (await repos.branches.create({ businessId: bizB, name: 'B1', slug: 'b1' })).id;
    const provisioning = new RoleProvisioningService(repos);
    const rolesA = await provisioning.seedDefaultRoles(bizA, ownerId);
    const rolesB = await provisioning.seedDefaultRoles(bizB, ownerBId);
    const grant = (userId: string, businessId: string, roleId: string, branchId: string | null) =>
      repos.userBusinessRoles.grant({ userId, businessId, branchId, roleId, createdBy: userId });
    await grant(ownerId, bizA, rolesA.Owner, null); await grant(ownerBId, bizB, rolesB.Owner, null);
    await grant(staffId, bizA, rolesA.Staff, a1);
    ownerToken = await signAccessToken(ownerId, SECRET); ownerBToken = await signAccessToken(ownerBId, SECRET);
    const staffLogin = await http('POST', '/auth/login', { body: { email: staffEmail, password: PW } });
    staffWebRefresh = staffLogin.data.refreshToken;
    // a customer with an active membership and loyalty account at business A, and a branch-restricted voucher
    customerId = (await repos.customers.create({ phone: `+1557${run.replace(/\D/g, '').padEnd(8, '1').slice(0, 7)}`, phoneVerifiedAt: new Date() })).id;
    const joined = await new CustomerMembershipService(db).join({
      customerId, businessId: bizA, onboardingSource: 'integration_test', onboardingReference: a1, consentVersion: 'v1',
    });
    accountA = joined.loyaltyAccount.id;
    customerToken = await signCustomerAccessToken(customerId, CUSTOMER_SECRET);
    voucherId = (await repos.loyaltyRewards.create({
      businessId: bizA, name: 'Branch A1 voucher', type: 'voucher', rewardValue: '5.00', cooldownSeconds: 0, branchId: a1, pointsCost: 1,
    })).id;
    const first = await newCashier('multiple', [a1, a2, a3]);
    expect(first.id).toBeTruthy();
  });
  afterAll(async () => { await client?.end(); });

  describe('a valid switch', () => {
    it('moves the live session to another assigned branch without a password and returns minimal data', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      const s = await sessionOn(u.username, a1);
      expect(s.session.canSwitchBranch).toBe(true);
      const res = await switchTo(s.refreshToken, a2, a1);
      expect(res.status, JSON.stringify(res)).toBe(200);
      expect(res.data.switched).toBe(true);
      expect(res.data.session).toMatchObject({ businessId: bizA, branchId: a2, branchName: 'A2', canSwitchBranch: true });
      expect(Object.keys(res.data).sort()).toEqual(['accessToken', 'refreshToken', 'session', 'switched']);
      const m = await me(res.data.accessToken);
      expect(m.data.branchId).toBe(a2);
      expect([...m.data.permissions].sort()).toEqual(['branches:view', 'business:view', 'loyalty:serve']);
      const live = await liveSessions(u.id);
      expect(live).toHaveLength(1);
      expect(live[0].branch_id).toBe(a2);
    });

    it('ends the previous branch authorization at once: the old access token and refresh token stop working', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      expect((await me(s.accessToken)).status).toBe(200);
      const res = await switchTo(s.refreshToken, a2);
      expect(res.status).toBe(200);
      expect((await me(s.accessToken)).status).toBe(401); // stale access token, still inside its 15 minute lifetime
      const staleRefresh = await http('POST', '/auth/cashier/refresh', { body: { refreshToken: s.refreshToken } });
      expect(staleRefresh.status).toBe(409); // inside the concurrent-rotation grace window
      expect((await me(res.data.accessToken)).status).toBe(200); // the grace response did not harm the new session
    });

    it('refresh after switching keeps the new branch and rotates normally', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const sw = await switchTo(s.refreshToken, a2);
      const rf = await http('POST', '/auth/cashier/refresh', { body: { refreshToken: sw.data.refreshToken } });
      expect(rf.status).toBe(200);
      expect(rf.data.session).toMatchObject({ branchId: a2, canSwitchBranch: true });
      expect((await me(rf.data.accessToken)).data.branchId).toBe(a2);
    });

    it('the switched session can switch again, and back, each time replacing the session', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      let s = await sessionOn(u.username, a1);
      for (const target of [a2, a3, a1]) {
        const r = await switchTo(s.refreshToken, target);
        expect(r.status, `${target}: ${JSON.stringify(r)}`).toBe(200);
        s = r.data;
        expect((await me(s.accessToken)).data.branchId).toBe(target);
        expect(await liveSessions(u.id)).toHaveLength(1);
      }
    });

    it('a switch to the branch already active is a safe, documented no-op (200, switched:false, nothing rotated or audited)', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const before = await liveSessions(u.id);
      const res = await switchTo(s.refreshToken, a1);
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ switched: false, session: { branchId: a1 } });
      expect(res.data.accessToken).toBeUndefined();
      expect(await liveSessions(u.id)).toEqual(before);
      expect((await me(s.accessToken)).status).toBe(200);
      expect(await q(`SELECT 1 FROM audit_log WHERE actor_user_id = $1 AND action = 'auth.cashier_branch_switched'`, [u.id])).toHaveLength(0);
    });
  });

  describe('who may switch, and to where (server-side only)', () => {
    it('a single-branch account cannot switch: another branch is refused, its own branch is a no-op, and nothing changes', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      expect(s.session.canSwitchBranch).toBe(false);
      const other = await switchTo(s.refreshToken, a2);
      expect(other.status).toBe(403);
      expect(other.error?.code).toBe('CASHIER_ACCESS_DENIED');
      expect((await switchTo(s.refreshToken, a1)).data.switched).toBe(false);
      expect((await me(s.accessToken)).status).toBe(200);
      expect(await liveSessions(u.id)).toHaveLength(1);
      const lst = await http('POST', '/auth/cashier/branches', { body: { refreshToken: s.refreshToken } });
      expect(lst.data).toMatchObject({ canSwitchBranch: false, current: { id: a1 } });
      expect(lst.data.branches).toHaveLength(1);
    });

    it('an unassigned branch of the same business is refused and the session is left exactly as it was', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const before = await liveSessions(u.id);
      const res = await switchTo(s.refreshToken, a3);
      expect(res.status).toBe(403);
      expect(res.error?.code).toBe('CASHIER_ACCESS_DENIED');
      expect(await liveSessions(u.id)).toEqual(before);
      expect((await me(s.accessToken)).data.branchId).toBe(a1);
      expect((await http('POST', '/auth/cashier/refresh', { body: { refreshToken: s.refreshToken } })).status).toBe(200);
    });

    it("another business's branch, a random id and a malformed id are refused (cross-tenant identifier manipulation)", async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      expect((await switchTo(s.refreshToken, b1)).status).toBe(403);
      expect((await switchTo(s.refreshToken, randomUUID())).status).toBe(403);
      expect((await http('POST', '/auth/cashier/switch-branch', { body: { refreshToken: s.refreshToken, branchId: 'not-a-uuid' } })).status).toBe(400);
      expect((await http('POST', '/auth/cashier/switch-branch', { body: { refreshToken: s.refreshToken } })).status).toBe(400);
      expect((await me(s.accessToken)).data.branchId).toBe(a1);
    });

    it('denied attempts are recorded as security events attributed to the cashier and business, with no token material', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      await switchTo(s.refreshToken, a3);
      const rows = await q(`SELECT business_id, metadata FROM audit_log WHERE actor_user_id = $1 AND action = 'security.authorization_failed' ORDER BY created_at DESC LIMIT 1`, [u.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].business_id).toBe(bizA);
      expect(rows[0].metadata).toMatchObject({ errorCode: 'CASHIER_ACCESS_DENIED', client: 'cashier' });
      expect(JSON.stringify(rows[0].metadata)).not.toMatch(/eyJ|refreshToken|accessToken/);
    });

    it('an unchanged assignment of two branches still lists exactly the assigned branches for the dialog', async () => {
      const u = await newCashier('multiple', [a2, a3]);
      const s = await sessionOn(u.username, a2);
      const lst = await http('POST', '/auth/cashier/branches', { body: { refreshToken: s.refreshToken } });
      expect(lst.status).toBe(200);
      expect(lst.data.branches.map((b: { id: string }) => b.id).sort()).toEqual([a2, a3].sort());
      expect(lst.data.current.id).toBe(a2);
      expect(lst.data.canSwitchBranch).toBe(true);
    });
  });

  describe('identities that must not switch', () => {
    it('a disabled cashier cannot switch (its sessions were revoked by the disable), and can again once re-enabled and signed in', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      expect((await admin('POST', `/cashier-accounts/${u.id}/disable`)).status).toBe(200);
      expect((await switchTo(s.refreshToken, a2)).status).toBe(401);
      expect((await admin('POST', `/cashier-accounts/${u.id}/enable`)).status).toBe(200);
      const again = await sessionOn(u.username, a1);
      expect((await switchTo(again.refreshToken, a2)).status).toBe(200);
    });

    it('a revoked session cannot switch (sign-out of devices, and a revoked account)', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      expect((await admin('POST', `/cashier-accounts/${u.id}/revoke-sessions`)).status).toBe(200);
      expect((await switchTo(s.refreshToken, a2)).status).toBe(401);
      const v = await newCashier('multiple', [a1, a2]);
      const sv = await sessionOn(v.username, a1);
      expect((await admin('POST', `/cashier-accounts/${v.id}/revoke`)).status).toBe(200);
      expect((await switchTo(sv.refreshToken, a2)).status).toBe(401);
    });

    it('a credential reset during the session ends it: the old session cannot switch', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      expect((await admin('POST', `/cashier-accounts/${u.id}/reset-credential`, { password: 'reset-pass-12345' })).status).toBe(200);
      expect((await switchTo(s.refreshToken, a2)).status).toBe(401);
    });

    it('a locked identity cannot switch (fail closed) and nothing changes', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      await q(`UPDATE users SET locked_until = now() + interval '10 minutes', failed_login_count = 5 WHERE id = $1`, [u.id]);
      const res = await switchTo(s.refreshToken, a2);
      expect(res.status).toBe(403);
      expect(res.error?.code).toBe('CASHIER_ACCESS_DENIED');
      expect((await me(s.accessToken)).data.branchId).toBe(a1);
      expect(await liveSessions(u.id)).toHaveLength(1);
    });

    it('removing the TARGET branch assignment: the switch is refused; removing the CURRENT branch ends that session', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      const s = await sessionOn(u.username, a1);
      expect((await admin('PUT', `/cashier-accounts/${u.id}/branches`, { accessMode: 'multiple', branchIds: [a1, a2] })).status).toBe(200);
      expect((await switchTo(s.refreshToken, a3)).status).toBe(403);
      expect((await switchTo(s.refreshToken, a2)).status).toBe(200); // a still-assigned branch is fine
      const t = await sessionOn(u.username, a2);
      expect((await admin('PUT', `/cashier-accounts/${u.id}/branches`, { accessMode: 'multiple', branchIds: [a1, a3] })).status).toBe(200);
      expect((await switchTo(t.refreshToken, a1)).status).toBe(401); // its a2 session was revoked by the removal
    });

    it('a staff-email cashier session cannot switch (only managed identities may), and its session is untouched', async () => {
      const l = await http('POST', '/auth/cashier/login', { body: { email: staffEmail, password: PW } });
      expect(l.data.status).toBe('authenticated');
      const res = await switchTo(l.data.refreshToken, a2);
      expect(res.status).toBe(403);
      expect(res.error?.code).toBe('CASHIER_SWITCH_NOT_AVAILABLE');
      expect((await me(l.data.accessToken)).status).toBe(200);
      expect((await http('POST', '/auth/cashier/branches', { body: { refreshToken: l.data.refreshToken } })).error?.code).toBe('CASHIER_SWITCH_NOT_AVAILABLE');
    });
  });

  describe('forged, stolen and confused credentials', () => {
    it('forged, tampered, garbage and wrong-type credentials are refused and change nothing', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const parts = s.refreshToken.split('.');
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.sub = randomUUID();
      const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
      const iat = Math.floor(Date.now() / 1000);
      const wrongSecret = await sign({ sub: payload.sub, jti: payload.jti, type: 'refresh', iat, exp: iat + 600 }, 'some-other-secret', 'HS256');
      for (const bad of [tampered, wrongSecret, 'not.a.jwt', s.accessToken, '']) {
        const r = await switchTo(bad || 'x', a2);
        expect([400, 401], `${bad.slice(0, 20)}: ${r.status}`).toContain(r.status);
      }
      expect((await me(s.accessToken)).data.branchId).toBe(a1);
      expect(await liveSessions(u.id)).toHaveLength(1);
    });

    it('a staff web refresh token and a staff web access token are refused, and the web session is not revoked', async () => {
      const r = await switchTo(staffWebRefresh, a2);
      expect(r.status).toBe(401);
      const web = await http('POST', '/auth/refresh', { body: { refreshToken: staffWebRefresh } });
      expect(web.status).toBe(200); // not revoked by the refused cashier call
      const asBody = await switchTo(ownerToken, a2);
      expect(asBody.status).toBe(401);
    });

    it('a cashier ACCESS token presented as a bearer cannot reach the switch or listing routes (not on the allow-list)', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      for (const path of ['/auth/cashier/switch-branch', '/auth/cashier/branches']) {
        const r = await http('POST', path, { token: s.accessToken, body: { refreshToken: s.refreshToken, branchId: a2 } });
        expect(r.status).toBe(403);
        expect(r.error?.code).toBe('CASHIER_ROUTE_DENIED');
      }
      expect((await me(s.accessToken)).data.branchId).toBe(a1);
    });

    it('a managed cashier still cannot reach administrative routes after switching', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const sw = await switchTo(s.refreshToken, a2);
      for (const [m, p] of [['GET', '/cashier-accounts'], ['POST', '/cashier-accounts/reauth'], ['PATCH', '/businesses/me'], ['GET', '/team']] as const) {
        const r = await http(m, p, { token: sw.data.accessToken, businessId: bizA, ...(m === 'GET' ? {} : { body: {} }) });
        expect(r.error?.code, `${m} ${p}`).toBe('CASHIER_ROUTE_DENIED');
      }
    });

    it('a header naming the previous branch cannot override the new binding', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const sw = await switchTo(s.refreshToken, a2);
      const r = await me(sw.data.accessToken, { branchId: a1 });
      expect(r.status).toBe(403);
      expect(r.error?.code).toBe('CASHIER_CONTEXT_MISMATCH');
      expect((await me(sw.data.accessToken, { branchId: a2 })).status).toBe(200);
    });
  });

  describe('replay containment across a switch', () => {
    it('replaying the PRE-switch refresh token after the grace window is refused AND ends the new session too', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const sw = await switchTo(s.refreshToken, a2);
      expect(sw.status).toBe(200);
      await sleep(10_800); // past the 10 second concurrent-rotation grace
      const replay = await http('POST', '/auth/cashier/refresh', { body: { refreshToken: s.refreshToken } });
      expect(replay.status).toBe(401);
      expect((await me(sw.data.accessToken)).status).toBe(401); // the descendant session was contained as well
      expect(await liveSessions(u.id)).toHaveLength(0);
      const replaySwitch = await switchTo(s.refreshToken, a2);
      expect(replaySwitch.status).toBe(401);
    }, 30_000);
  });

  describe('concurrency and ordering', () => {
    it('two simultaneous switches with the same credential: exactly one wins, the other conflicts, one live session remains', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      const s = await sessionOn(u.username, a1);
      const [x, y] = await Promise.all([switchTo(s.refreshToken, a2), switchTo(s.refreshToken, a3)]);
      const won = [x, y].filter((r) => r.status === 200);
      const lost = [x, y].filter((r) => r.status !== 200);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect([409, 401]).toContain(lost[0]!.status);
      const live = await liveSessions(u.id);
      expect(live).toHaveLength(1);
      expect(live[0].branch_id).toBe((await me(won[0]!.data.accessToken)).data.branchId);
    });

    it('a stale expected branch is a conflict, never a silent change (two tabs, different cached branch)', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      const s = await sessionOn(u.username, a1);
      const tab1 = await switchTo(s.refreshToken, a2, a1); // tab 1 moves a1 -> a2
      expect(tab1.status).toBe(200);
      // Tab 2 still believes the session is on a1 and asks to go to a3, using the credential the cookies now hold.
      const tab2 = await switchTo(tab1.data.refreshToken, a3, a1);
      expect(tab2.status).toBe(409);
      expect(tab2.error?.code).toBe('CASHIER_SWITCH_CONFLICT');
      expect((await me(tab1.data.accessToken)).data.branchId).toBe(a2); // unchanged
      // Retrying with the true current branch succeeds.
      expect((await switchTo(tab1.data.refreshToken, a3, a2)).status).toBe(200);
    });

    it('a switch racing a branch removal never leaves a live session on a removed branch', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      const s = await sessionOn(u.username, a1);
      await Promise.all([
        switchTo(s.refreshToken, a3),
        admin('PUT', `/cashier-accounts/${u.id}/branches`, { accessMode: 'multiple', branchIds: [a1, a2] }),
      ]);
      const assigned = new Set((await q(`SELECT branch_id FROM user_business_roles WHERE user_id = $1 AND deleted_at IS NULL`, [u.id])).map((r) => r.branch_id));
      for (const live of await liveSessions(u.id)) expect(assigned.has(live.branch_id), `live session on ${live.branch_id}`).toBe(true);
    });

    it('a purchase racing a switch is attributed to exactly the branch it was authorised for, and is never duplicated', async () => {
      for (let i = 0; i < 6; i++) {
        const u = await newCashier('multiple', [a1, a2]);
        const s = await sessionOn(u.username, a1);
        const key = `race-purchase-${run}-${i}`;
        const [p, sw] = await Promise.all([purchase(s.accessToken, key), switchTo(s.refreshToken, a2)]);
        expect(sw.status).toBe(200);
        expect([200, 401, 409]).toContain(p.status);
        const rows = await q(`SELECT branch_id FROM loyalty_purchase_events WHERE idempotency_key = $1`, [key]);
        expect(rows.length).toBeLessThanOrEqual(1);
        if (rows.length === 1) expect(rows[0].branch_id).toBe(a1); // never re-attributed to the new branch
        // Retrying the same key under the NEW authorization: created once on a2 if the first did not land, otherwise a conflict (never a duplicate).
        const retry = await purchase(sw.data.accessToken, key);
        const after = await q(`SELECT branch_id FROM loyalty_purchase_events WHERE idempotency_key = $1`, [key]);
        expect(after).toHaveLength(1);
        if (rows.length === 0) { expect(retry.status).toBe(200); expect(after[0].branch_id).toBe(a2); } else { expect(retry.status).toBe(409); }
      }
    });

    it('a purchase authenticated BEFORE a switch but committing AFTER it is refused before it writes anything', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const m = await me(s.accessToken);
      expect(m.status).toBe(200);
      const sessionId = (await liveSessions(u.id))[0].session_id as string;
      expect((await switchTo(s.refreshToken, a2)).status).toBe(200);
      const key = `stale-guard-${run}`;
      await expect(new LoyaltyAccountService(db).recordPurchase({
        businessId: bizA, branchId: a1, accountId: accountA, purchaseAmount: 10, idempotencyKey: key, channel: 'other', staffUserId: u.id,
        cashierSession: { userId: u.id, sessionId, branchId: a1 },
      })).rejects.toMatchObject({ code: 'CASHIER_SESSION_CHANGED', status: 409 });
      expect(await q(`SELECT 1 FROM loyalty_purchase_events WHERE idempotency_key = $1`, [key])).toHaveLength(0);
      expect((await purchase(s.accessToken, key + '-http', a1)).status).toBe(401); // and over HTTP the stale token is refused outright
    });

    it('a switch waits for an in-flight mutation to commit (shared lock), then proceeds: a deterministic order', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const sessionId = (await liveSessions(u.id))[0].session_id as string;
      const holder = new Client({ connectionString: databaseUrl });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        const held = await holder.query(
          `SELECT id FROM refresh_tokens WHERE user_id = $1 AND session_id = $2 AND revoked_at IS NULL FOR SHARE`, [u.id, sessionId]);
        expect(held.rowCount).toBe(1);
        let finished = false;
        const pending = switchTo(s.refreshToken, a2).then((r) => { finished = true; return r; });
        await sleep(900);
        expect(finished, 'the switch must be blocked while a mutation holds the session').toBe(false);
        await holder.query('COMMIT'); // the in-flight mutation commits first, keeping its branch
        const res = await pending;
        expect(res.status).toBe(200);
        expect((await me(res.data.accessToken)).data.branchId).toBe(a2);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    });

    it('redemption: a branch-restricted reward confirms only on the active branch after a switch, once, and never twice', async () => {
      await purchase((await sessionOn((await newCashier('multiple', [a1, a2])).username, a1)).accessToken, `seed-points-${run}`);
      const issued = await http('POST', `/loyalty/me/accounts/${bizA}/issue`, { token: customerToken, body: { rewardId: voucherId } });
      expect(issued.status, JSON.stringify(issued)).toBe(201);
      const redemptionCode = issued.data.redemptionCode as string;
      const u = await newCashier('multiple', [a1, a2]);
      const onA1 = await sessionOn(u.username, a1);
      const sw = await switchTo(onA1.refreshToken, a2);
      expect(sw.status).toBe(200);
      const wrong = await http('POST', `/loyalty/redemptions/${redemptionCode}/confirm`, { token: sw.data.accessToken, businessId: bizA, body: {} });
      expect(wrong.status).toBe(422);
      expect(wrong.error?.code).toBe('LOYALTY_REDEMPTION_WRONG_BRANCH'); // uses the ACTIVE branch after the switch
      const back = await switchTo(sw.data.refreshToken, a1);
      expect(back.status).toBe(200);
      const [c1, c2] = await Promise.all([
        http('POST', `/loyalty/redemptions/${redemptionCode}/confirm`, { token: back.data.accessToken, businessId: bizA, body: {} }),
        http('POST', `/loyalty/redemptions/${redemptionCode}/confirm`, { token: back.data.accessToken, businessId: bizA, body: {} }),
      ]);
      expect([c1.status, c2.status].sort()).toEqual([200, 409]);
      expect(await q(`SELECT 1 FROM loyalty_transactions WHERE redemption_code = $1 AND redemption_confirmed_at IS NOT NULL`, [redemptionCode])).toHaveLength(1);
      // the in-transaction guard also protects a confirmation that raced a switch
      const stale = await q(`SELECT id FROM users WHERE id = $1`, [u.id]);
      expect(stale).toHaveLength(1);
      await expect(new LoyaltyRedemptionService(db).confirmRedemption(bizA, 'ZZZZZZZZ', a1, {
        userId: u.id, sessionId: (await q(`SELECT session_id FROM refresh_tokens WHERE user_id = $1 ORDER BY issued_at ASC LIMIT 1`, [u.id]))[0].session_id, branchId: a1,
      })).rejects.toMatchObject({ code: 'CASHIER_SESSION_CHANGED' });
    });
  });

  describe('atomicity and audit', () => {
    it('a failure while writing the audit row rolls the whole switch back: no new session, no revocation, no half state', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const before = await q(`SELECT id, revoked_at, session_id, branch_id FROM refresh_tokens WHERE user_id = $1 ORDER BY issued_at`, [u.id]);
      await q(`CREATE OR REPLACE FUNCTION fail_branch_switch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`);
      await q(`CREATE TRIGGER fail_branch_switch_audit_trg BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'auth.cashier_branch_switched') EXECUTE FUNCTION fail_branch_switch_audit()`);
      try {
        const res = await switchTo(s.refreshToken, a2);
        expect(res.status).toBe(500);
      } finally {
        await q(`DROP TRIGGER IF EXISTS fail_branch_switch_audit_trg ON audit_log`);
        await q(`DROP FUNCTION IF EXISTS fail_branch_switch_audit()`);
      }
      const after = await q(`SELECT id, revoked_at, session_id, branch_id FROM refresh_tokens WHERE user_id = $1 ORDER BY issued_at`, [u.id]);
      expect(after).toEqual(before);
      expect((await me(s.accessToken)).data.branchId).toBe(a1);
      expect(await q(`SELECT 1 FROM audit_log WHERE actor_user_id = $1 AND action = 'auth.cashier_branch_switched'`, [u.id])).toHaveLength(0);
      expect((await switchTo(s.refreshToken, a2)).status).toBe(200); // and the switch works once the fault is gone
    });

    it('every successful switch writes one complete audit row, and no token, password or hash appears in any audit row', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      let s = await sessionOn(u.username, a1);
      const sessions: string[] = [(await liveSessions(u.id))[0].session_id];
      for (const target of [a2, a3]) {
        const r = await switchTo(s.refreshToken, target);
        expect(r.status).toBe(200);
        s = r.data;
        sessions.push((await liveSessions(u.id))[0].session_id);
      }
      const rows = await q(`SELECT action, entity_type, entity_id, business_id, actor_user_id, created_at, metadata FROM audit_log WHERE actor_user_id = $1 AND action = 'auth.cashier_branch_switched' ORDER BY created_at`, [u.id]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ entity_type: 'session', business_id: bizA, actor_user_id: u.id, entity_id: sessions[1] });
      expect(rows[0].metadata).toMatchObject({ client: 'cashier', outcome: 'success', method: 'branch_switch', fromBranchId: a1, toBranchId: a2, previousSessionId: sessions[0], sessionId: sessions[1] });
      expect(rows[1].metadata).toMatchObject({ fromBranchId: a2, toBranchId: a3, previousSessionId: sessions[1], sessionId: sessions[2] });
      expect(rows[0].created_at).toBeInstanceOf(Date);
      const leaks = await q(`SELECT count(*)::int n FROM audit_log WHERE metadata::text ~* 'eyJ' OR metadata::text ~* 'refreshToken' OR metadata::text ~* 'accessToken' OR metadata::text ~* 'pbkdf2' OR metadata::text ~* 'cashier-pass-1'`);
      expect(leaks[0].n).toBe(0);
    });

    it('the switch shows up in the existing cashier activity history category (session)', async () => {
      const { SESSION_ACTIONS } = await import('../../src/cashier-activity/categories');
      expect(SESSION_ACTIONS).toContain('auth.cashier_branch_switched');
    });
  });
});
