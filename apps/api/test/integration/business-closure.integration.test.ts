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
import { businessClosureRoutes } from '../../src/business-closure/business-closure.routes';
import { platformBusinessClosureRoutes } from '../../src/platform/business-closure.routes';
import { signAccessToken, signCashierAccessToken } from '../../src/auth/jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';

/**
 * BIZ-CLOSE-01 against real PostgreSQL and the real middleware: owner-only authorization, re-authentication, explicit confirmation,
 * idempotency, concurrency, audit evidence, the immutability guard, tenant isolation, the controlled BLOCKED state, and proof that filing
 * a request changes nothing about the business or its customers.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Business closure tests need a loopback PostgreSQL database.');
}

const SECRET = 'closure-fixture-access-secret';
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
const alerts: unknown[] = [];

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/cashier-accounts', cashierAccountRoutes);
app.route('/api/v1/business-closure', businessClosureRoutes);
app.route('/api/v1/platform/business-closure', platformBusinessClosureRoutes);
app.onError(errorHandler);

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
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: 'closure-refresh',
    PASSWORD_HASHER: hasherNamespace, AUTH_RATE_LIMITER: allow, API_RATE_LIMITER: allow, PUBLIC_RATE_LIMITER: allow, LOOKUP_RATE_LIMITER: allow,
    OPS_ALERT_WEBHOOK_URL: undefined, ENVIRONMENT: 'test',
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, {
    method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  if (path.endsWith('/requests') && response.status < 300) alerts.push(path);
  let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* an unrouted path answers plain text */ }
  return { status: response.status, ...parsed };
}

describe.skipIf(!databaseUrl)('BIZ-CLOSE-01 business closure request (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const PW = 'an-owner-password-1';
  const tag = run.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)] as string).replace(/-/g, '');
  let bizA: string; let bizB: string; let ownerA: string; let ownerB: string; let managerA: string; let platformAdmin: string;
  let ownerAToken: string; let ownerBToken: string; let managerToken: string; let platformToken: string; let nameA = '';

  const proof = async (token: string, businessId: string, password = PW) =>
    http('POST', '/business-closure/reauth', { token, businessId, body: { password } });
  const freshProof = async (token: string, businessId: string) => {
    const r = await proof(token, businessId);
    expect(r.status, JSON.stringify(r)).toBe(200);
    return r.data.proof as string;
  };
  const file = (token: string, businessId: string, p: string, name = nameA) =>
    http('POST', '/business-closure/requests', { token, businessId, headers: { 'X-Reauth-Proof': p }, body: { confirmBusinessName: name } });
  const withdraw = (token: string, businessId: string, p: string) =>
    http('POST', '/business-closure/requests/withdraw', { token, businessId, headers: { 'X-Reauth-Proof': p }, body: {} });
  const pendingRows = (businessId: string) => q(`SELECT * FROM business_closure_requests WHERE business_id = $1 AND status = 'pending'`, [businessId]);
  const snapshotOfBusiness = async (businessId: string) => (await q(
    `SELECT (SELECT status FROM businesses WHERE id = $1) AS status,
            (SELECT count(*)::int FROM loyalty_accounts WHERE business_id = $1) AS accounts,
            (SELECT coalesce(sum(points),0)::int FROM loyalty_accounts WHERE business_id = $1) AS points,
            (SELECT count(*)::int FROM business_customer_memberships WHERE business_id = $1) AS memberships,
            (SELECT count(*)::int FROM user_business_roles WHERE business_id = $1) AS roles`, [businessId]))[0];

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    repos = createRepositories(buildDb(client));
    const mkUser = async (email: string, label: string) => (await repos.users.create({
      email, fullName: label, passwordHash: await pbkdf2Hash(PW, 1000), status: 'active',
    })).id;
    ownerA = await mkUser(`bc-owner-${run}@example.test`, 'owner');
    ownerB = await mkUser(`bc-ownerb-${run}@example.test`, 'ownerb');
    managerA = await mkUser(`bc-manager-${run}@example.test`, 'manager');
    platformAdmin = await mkUser(`bc-admin-${run}@example.test`, 'admin');
    await q(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [platformAdmin]);
    nameA = `Closure Cafe ${tag}`;
    bizA = (await repos.businesses.create({ name: nameA, slug: `bc-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: `Closure Bakery ${tag}`, slug: `bc-b-${run}` })).id;
    const rolesA = await new RoleProvisioningService(repos).seedDefaultRoles(bizA, ownerA);
    const rolesB = await new RoleProvisioningService(repos).seedDefaultRoles(bizB, ownerB);
    const grant = (userId: string, businessId: string, roleId: string) =>
      repos.userBusinessRoles.grant({ userId, businessId, branchId: null, roleId, createdBy: userId });
    await grant(ownerA, bizA, rolesA.Owner); await grant(ownerB, bizB, rolesB.Owner); await grant(managerA, bizA, rolesA.Manager);
    ownerAToken = await signAccessToken(ownerA, SECRET); ownerBToken = await signAccessToken(ownerB, SECRET);
    managerToken = await signAccessToken(managerA, SECRET); platformToken = await signAccessToken(platformAdmin, SECRET);
    // Real customer state in business A: a membership-less account holding points, so the obligations are non-trivial.
    const customer = (await repos.customers.create({ phone: `+1559${run.replace(/\D/g, '').padEnd(8, '3').slice(0, 7)}` })).id;
    await q(`INSERT INTO loyalty_accounts (customer_id, business_id, points) VALUES ($1, $2, 120)`, [customer, bizA]);
  });
  afterAll(async () => { await client?.end(); });

  describe('authorization', () => {
    it('only the Owner (business:delete, business-wide) can read, re-authenticate or file; Manager, anonymous and cashier tokens cannot', async () => {
      expect((await http('GET', '/business-closure', { token: managerToken, businessId: bizA })).status).toBe(403);
      expect((await proof(managerToken, bizA)).status).toBe(403);
      expect((await http('GET', '/business-closure', { businessId: bizA })).status).toBe(401);
      const cashier = await signCashierAccessToken(ownerA, SECRET, { sessionId: randomUUID(), businessId: bizA });
      const denied = await http('GET', '/business-closure', { token: cashier, businessId: bizA });
      expect(denied.status).toBe(403);
      expect(denied.error?.code).toBe('CASHIER_ROUTE_DENIED');
      const owner = await http('GET', '/business-closure', { token: ownerAToken, businessId: bizA });
      expect(owner.status, JSON.stringify(owner)).toBe(200);
    });

    it('an owner of another business cannot read or act on this one (tenant isolation)', async () => {
      expect((await http('GET', '/business-closure', { token: ownerBToken, businessId: bizA })).status).toBe(403);
      const p = await freshProof(ownerBToken, bizB);
      expect((await file(ownerBToken, bizA, p)).status).toBe(403);
    });
  });

  describe('re-authentication and confirmation', () => {
    it('a wrong password yields no proof; filing without a proof, with another purpose\'s proof, or another business\'s proof is refused', async () => {
      expect((await proof(ownerAToken, bizA, 'wrong-password-1')).status).toBe(401);
      const none = await http('POST', '/business-closure/requests', { token: ownerAToken, businessId: bizA, body: { confirmBusinessName: nameA } });
      expect(none.status).toBe(403); expect(none.error?.code).toBe('REAUTH_REQUIRED');
      const cashierProof = await http('POST', '/cashier-accounts/reauth', { token: ownerAToken, businessId: bizA, body: { password: PW } });
      expect(cashierProof.status, JSON.stringify(cashierProof)).toBe(200);
      const wrongPurpose = await file(ownerAToken, bizA, cashierProof.data.proof);
      expect(wrongPurpose.status).toBe(403); expect(wrongPurpose.error?.code).toBe('REAUTH_REQUIRED');
      const foreign = await freshProof(ownerBToken, bizB);
      expect((await file(ownerAToken, bizA, foreign)).status).toBe(403);
      expect(await pendingRows(bizA)).toHaveLength(0);
    });

    it('a missing or mistyped business name is refused and records nothing', async () => {
      const p = await freshProof(ownerAToken, bizA);
      const wrong = await file(ownerAToken, bizA, p, 'Some Other Name');
      expect(wrong.status).toBe(422); expect(wrong.error?.code).toBe('CONFIRMATION_MISMATCH');
      expect((await file(ownerAToken, bizA, p, '   ')).status).toBeGreaterThanOrEqual(400);
      expect((await http('POST', '/business-closure/requests', { token: ownerAToken, businessId: bizA, headers: { 'X-Reauth-Proof': p }, body: { confirmBusinessName: nameA, businessId: bizB } })).status).toBe(400);
      expect(await pendingRows(bizA)).toHaveLength(0);
    });
  });

  describe('the request, the blocked state and its evidence', () => {
    it('files once, is idempotent, concurrency-safe, audited, and changes nothing about the business or its customers', async () => {
      const before = await snapshotOfBusiness(bizA);
      const p = await freshProof(ownerAToken, bizA);
      const results = await Promise.all(Array.from({ length: 6 }, () => file(ownerAToken, bizA, p)));
      for (const r of results) expect([200, 201], JSON.stringify(r)).toContain(r.status);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(new Set(results.map((r) => r.data.request.id)).size).toBe(1);
      const rows = await pendingRows(bizA);
      expect(rows).toHaveLength(1);
      expect(rows[0].obligations_snapshot).toMatchObject({ customerPointsOutstanding: 120, customerPointBalances: 1 });
      const audit = await q(`SELECT * FROM audit_log WHERE action = 'business.closure_requested' AND business_id = $1`, [bizA]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: ownerA, entity_id: rows[0].id });
      expect(JSON.stringify(audit[0].metadata)).not.toMatch(/phone|email|password|eyJ/i);
      expect(await snapshotOfBusiness(bizA)).toEqual(before); // nothing deleted, suspended, forfeited or changed
      expect(alerts.length).toBeGreaterThan(0);
    });

    it('reports the controlled BLOCKED state with the real obligations and no processing path', async () => {
      const r = await http('GET', '/business-closure', { token: ownerAToken, businessId: bizA });
      expect(r.status).toBe(200);
      expect(r.data.request.status).toBe('pending');
      expect(r.data.eligibility.processing).toBe('blocked');
      expect(r.data.eligibility.blockers).toEqual(expect.arrayContaining(['CLOSURE_POLICY_NOT_APPROVED', 'CUSTOMER_POINTS_OUTSTANDING']));
      expect(r.data.eligibility.obligations.customerPointsOutstanding).toBe(120);
      expect(JSON.stringify(r.data)).not.toMatch(/phone|email|@/);
      for (const [method, path] of [['POST', '/business-closure/process'], ['POST', '/business-closure/approve'], ['DELETE', '/business-closure']] as const) {
        const x = await http(method, path, { token: ownerAToken, businessId: bizA });
        expect([404, 405]).toContain(x.status);
      }
    });

    it('is invisible to another business', async () => {
      const r = await http('GET', '/business-closure', { token: ownerBToken, businessId: bizB });
      expect(r.data.request).toBeNull();
      expect(r.data.eligibility.obligations.customerPointsOutstanding).toBe(0);
      const w = await withdraw(ownerBToken, bizB, await freshProof(ownerBToken, bizB));
      expect(w.status).toBe(200); expect(w.data.request).toBeNull();
      expect(await pendingRows(bizA)).toHaveLength(1); // B's withdrawal touched nothing of A's
    });

    it('platform admins can see it read-only; other callers cannot', async () => {
      const list = await http('GET', '/platform/business-closure', { token: platformToken });
      expect(list.status, JSON.stringify(list)).toBe(200);
      expect(list.data.some((x: { businessId: string }) => x.businessId === bizA)).toBe(true);
      const id = (await pendingRows(bizA))[0].id as string;
      const detail = await http('GET', `/platform/business-closure/${id}`, { token: platformToken });
      expect(detail.status).toBe(200); expect(detail.data.eligibility.processing).toBe('blocked');
      expect((await http('GET', '/platform/business-closure', { token: ownerAToken })).status).toBe(403);
      expect((await http('POST', `/platform/business-closure/${id}/approve`, { token: platformToken })).status).toBeGreaterThanOrEqual(404);
    });
  });

  describe('withdrawal and the immutability guard', () => {
    it('the database admits only pending -> cancelled; no processed, edit, delete or truncate', async () => {
      const [row] = await pendingRows(bizA);
      await expect(q(`UPDATE business_closure_requests SET status = 'processed' WHERE id = $1`, [row.id])).rejects.toThrow(/BUSINESS_CLOSURE_REQUEST_IMMUTABLE|check/i);
      await expect(q(`UPDATE business_closure_requests SET requested_by_user_id = $2 WHERE id = $1`, [row.id, ownerB])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`DELETE FROM business_closure_requests WHERE id = $1`, [row.id])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`TRUNCATE business_closure_requests`)).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`INSERT INTO business_closure_requests (business_id, requested_by_user_id, status, obligations_snapshot) VALUES ($1, $2, 'processed', '{}')`, [bizB, ownerB])).rejects.toThrow();
    });

    it('the owner can withdraw (audited, idempotent) and file again as a new request', async () => {
      const first = (await pendingRows(bizA))[0].id as string;
      const p = await freshProof(ownerAToken, bizA);
      const w = await withdraw(ownerAToken, bizA, p);
      expect(w.status, JSON.stringify(w)).toBe(200);
      expect(w.data.request).toMatchObject({ id: first, status: 'cancelled' });
      expect((await withdraw(ownerAToken, bizA, p)).data.request).toBeNull();
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'business.closure_withdrawn' AND business_id = $1`, [bizA])).toHaveLength(1);
      const again = await file(ownerAToken, bizA, p);
      expect(again.status).toBe(201);
      expect(again.data.request.id).not.toBe(first);
      expect(await q(`SELECT 1 FROM business_closure_requests WHERE business_id = $1`, [bizA])).toHaveLength(2);
    });
  });

  describe('suspended businesses do not bypass restrictions', () => {
    it('a suspended business cannot read or file a closure request (BUSINESS_NOT_ACTIVE) and nothing is recorded', async () => {
      const bizC = (await repos.businesses.create({ name: `Closure Kiosk ${tag}`, slug: `bc-c-${run}` })).id;
      const rolesC = await new RoleProvisioningService(repos).seedDefaultRoles(bizC, ownerB);
      await repos.userBusinessRoles.grant({ userId: ownerB, businessId: bizC, branchId: null, roleId: rolesC.Owner, createdBy: ownerB });
      const p = await freshProof(ownerBToken, bizC);
      await q(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [bizC]);
      const read = await http('GET', '/business-closure', { token: ownerBToken, businessId: bizC });
      expect(read.status).toBe(403); expect(read.error?.code).toBe('BUSINESS_NOT_ACTIVE');
      const filed = await file(ownerBToken, bizC, p, `Closure Kiosk ${tag}`);
      expect(filed.status).toBe(403); expect(filed.error?.code).toBe('BUSINESS_NOT_ACTIVE');
      expect(await q(`SELECT 1 FROM business_closure_requests WHERE business_id = $1`, [bizC])).toHaveLength(0);
    });
  });
});
