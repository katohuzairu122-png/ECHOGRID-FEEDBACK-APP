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
import { branchRoutes } from '../../src/branches/branch.routes';
import { loyaltyRoutes } from '../../src/loyalty/loyalty.routes';
import { businessRoutes } from '../../src/businesses/business.routes';
import { cashierAccountRoutes } from '../../src/cashier-accounts/cashier-accounts.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';

/**
 * SEC-CASHIER-02D-R2: deleting a branch must end the cashier sessions bound to it. (Historic header of the cloned fixture: the race between issuing a branch-bound cashier session (switch, refresh, sign-in) and an administrator
 * removing that branch, disabling the account or resetting its credential.
 *
 * The defect: the administrator's revocation runs under the users-row lock, while the session-issuing paths read eligibility and
 * insert the new session row WITHOUT any lock that conflicts with it. Under READ COMMITTED the administrator's UPDATE cannot see a
 * session row that an in-flight issuer has inserted but not yet committed, so that row survives, live, on a branch whose grant is gone.
 *
 * Determinism: instead of relying on timing, a second connection holds `LOCK TABLE audit_log`. Both the switch and the administrator
 * write an audit row as the LAST step of their transaction, so each one stops exactly there, with all its other work done but
 * uncommitted. The test then releases the lock and asserts the DATABASE state, not just the HTTP answers. A third group repeats the
 * unsynchronised race for 20+ rounds per scenario.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Revocation race tests need a loopback PostgreSQL database.');
}

const SECRET = 'revocation-race-access-secret';
const REFRESH_SECRET = 'revocation-race-refresh-secret';
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
app.route('/api/v1/branches', branchRoutes);
app.route('/api/v1/loyalty', loyaltyRoutes);
app.route('/api/v1/cashier-accounts', cashierAccountRoutes);
app.onError(errorHandler);

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
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET, CUSTOMER_JWT_SECRET: 'branch-delete-customer-secret', QR_TOKEN_SECRET: 'branch-delete-qr-secret', WEB_BASE_URL: 'https://web.example.test',
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

describe.skipIf(!databaseUrl)('SEC-CASHIER-02D-R2 branch deletion versus cashier sessions (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  let locker: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const PW = 'an-owner-password-1';
  const cashierPw = 'cashier-pass-1';
  let bizA: string; let bizB: string; let a1: string; let a2: string; let a3: string; let b1: string;
  let ownerToken: string; let ownerId: string;
  let code = '';
  let seq = 0;

  let cachedProof = '';
  const admin = async (method: string, path: string, body?: unknown) => {
    if (!cachedProof) {
      const r = await http('POST', '/cashier-accounts/reauth', { token: ownerToken, businessId: bizA, body: { password: PW } });
      expect(r.status, JSON.stringify(r)).toBe(200);
      cachedProof = r.data.proof as string;
    }
    return http(method, path, { token: ownerToken, businessId: bizA, headers: { 'X-Reauth-Proof': cachedProof }, ...(body === undefined ? {} : { body }) });
  };
  const newCashier = async (branchIds: string[]) => {
    const username = `rr${run.slice(0, 6)}x${++seq}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const r = await admin('POST', '/cashier-accounts', { username, displayName: `Race ${username}`, accessMode: 'multiple', branchIds, password: cashierPw });
    expect(r.status, JSON.stringify(r)).toBe(201);
    code = r.data.cashierCode;
    return { id: r.data.account.id as string, username };
  };
  type Session = { accessToken: string; refreshToken: string; session: { branchId: string } };
  const sessionOn = async (username: string, branchId: string): Promise<Session> => {
    const l = await http('POST', '/auth/cashier/managed-login', { body: { businessCode: code, username, password: cashierPw } });
    if (l.data?.status === 'authenticated') return l.data as Session;
    const s = await http('POST', '/auth/cashier/session', { body: { ticket: l.data.ticket, businessId: bizA, branchId } });
    expect(s.status, JSON.stringify(s)).toBe(200);
    return s.data as Session;
  };
  const switchTo = (refreshToken: string, branchId: string, fromBranchId?: string) =>
    http('POST', '/auth/cashier/switch-branch', { body: { refreshToken, branchId, ...(fromBranchId ? { fromBranchId } : {}) } });
  const refresh = (refreshToken: string) => http('POST', '/auth/cashier/refresh', { body: { refreshToken } });

  const live = (userId: string) => q(
    `SELECT session_id, branch_id FROM refresh_tokens WHERE user_id = $1 AND client = 'cashier' AND revoked_at IS NULL AND expires_at > now() ORDER BY issued_at`, [userId]);
  const grantedBranches = async (userId: string) =>
    new Set((await q(`SELECT branch_id FROM user_business_roles WHERE user_id = $1 AND deleted_at IS NULL AND branch_id IS NOT NULL`, [userId])).map((r) => r.branch_id as string));
  // ---- deterministic pausing: a second connection holds the audit table, so the LAST write of each transaction waits ----
  const holdAuditTable = async () => { await locker.query('BEGIN'); await locker.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE'); };
  const releaseAuditTable = async () => { await locker.query('COMMIT'); };
  const waitingBackends = async () =>
    Number((await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`))[0].n);
  const waitUntilWaiting = async (atLeast: number, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if ((await waitingBackends()) >= atLeast) return; await sleep(25); }
    throw new Error(`expected ${atLeast} blocked backend(s), saw ${await waitingBackends()}`);
  };
  /** Parks the first operation at its final audit write, starts the second, lets it run as far as it can, then releases both. */
  const parked = async <A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> => {
    await holdAuditTable();
    let p1: Promise<A>; let p2: Promise<B>;
    try {
      p1 = first();
      await waitUntilWaiting(1);
      p2 = second();
      await sleep(500); // the second runs as far as it can: to its own audit write, or it waits on a lock the first holds
    } catch (error) {
      await releaseAuditTable();
      throw error;
    }
    await releaseAuditTable();
    return [await p1, await p2];
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    locker = new Client({ connectionString: databaseUrl }); await locker.connect();
    db = buildDb(client);
    repos = createRepositories(db);
    const mkUser = async (label: string) => (await repos.users.create({
      email: `rr-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash(PW, 1000), status: 'active',
    })).id;
    ownerId = await mkUser('owner');
    const ownerBId = await mkUser('ownerb');
    bizA = (await repos.businesses.create({ name: 'Race A', slug: `rr-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: 'Race B', slug: `rr-b-${run}` })).id;
    a1 = (await repos.branches.create({ businessId: bizA, name: 'A1', slug: 'a1' })).id;
    a2 = (await repos.branches.create({ businessId: bizA, name: 'A2', slug: 'a2' })).id;
    a3 = (await repos.branches.create({ businessId: bizA, name: 'A3', slug: 'a3' })).id;
    b1 = (await repos.branches.create({ businessId: bizB, name: 'B1', slug: 'b1' })).id;
    const provisioning = new RoleProvisioningService(repos);
    const rolesA = await provisioning.seedDefaultRoles(bizA, ownerId);
    const rolesB = await provisioning.seedDefaultRoles(bizB, ownerBId);
    const grant = (userId: string, businessId: string, roleId: string) =>
      repos.userBusinessRoles.grant({ userId, businessId, branchId: null, roleId, createdBy: userId });
    await grant(ownerId, bizA, rolesA.Owner); await grant(ownerBId, bizB, rolesB.Owner);
    ownerToken = await signAccessToken(ownerId, SECRET);
    await newCashier([a1, a2, a3]); // reads the business code
  });
  afterAll(async () => { await locker?.end(); await client?.end(); });


  const del = (branchId: string) => http('DELETE', `/branches/${branchId}`, { token: ownerToken, businessId: bizA, branchId });
  const invite = (token: string, branchId: string) => http('POST', '/loyalty/actions/onboarding-invite', { token, businessId: bizA, branchId });
  const liveOnBranch = async (branchId: string) => Number((await q(
    `SELECT count(*)::int n FROM refresh_tokens WHERE client='cashier' AND business_id=$1 AND branch_id=$2 AND revoked_at IS NULL AND expires_at > now()`, [bizA, branchId]))[0].n);

  let bseq = 0;
  const freshBranch = async () => (await repos.branches.create({ businessId: bizA, name: `F${++bseq}`, slug: `f${bseq}-${run.slice(0, 6)}` })).id;

  it('a session on a deleted branch performs nothing, cannot refresh, and holds no live row afterwards', async () => {
    const x1 = await freshBranch(); const x2 = await freshBranch();
    const u = await newCashier([x1, x2]);
    const s1 = await sessionOn(u.username, x1);
    const s2 = await sessionOn(u.username, x2);
    expect((await invite(s1.accessToken, x1)).status).toBe(200);
    const d = await del(x1);
    expect(d.status, JSON.stringify(d)).toBe(204);
    // authority: the deleted branch's session cannot serve, the other branch's session is untouched
    const after = await invite(s1.accessToken, x1);
    expect(after.status, JSON.stringify(after)).toBeGreaterThanOrEqual(401);
    expect((await invite(s2.accessToken, x2)).status).toBe(200);
    // state, BEFORE any refresh: no live session row may remain on the deleted branch (the defect: it stayed live until refresh/expiry)
    expect(await liveOnBranch(x1)).toBe(0);
    expect((await refresh(s1.refreshToken)).status).toBeGreaterThanOrEqual(401);
    expect(await liveOnBranch(x2)).toBeGreaterThanOrEqual(1);
  });

  it('deletion revokes only that branch: other branches of the same business keep working, other businesses are not addressable', async () => {
    const x1 = await freshBranch(); const x3 = await freshBranch();
    const u = await newCashier([x1, x3]);
    const s3 = await sessionOn(u.username, x3);
    await sessionOn(u.username, x1);
    expect((await del(x1)).status).toBe(204);
    expect(await liveOnBranch(x1)).toBe(0);
    expect((await invite(s3.accessToken, x3)).status).toBe(200);
    const other = await http('DELETE', `/branches/${b1}`, { token: ownerToken, businessId: bizA });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(Number((await q(`SELECT count(*)::int n FROM branches WHERE id=$1 AND is_deleted=false`, [b1]))[0].n)).toBe(1);
  });

  it('a failed deletion revokes nothing', async () => {
    const x1 = await freshBranch(); const x2 = await freshBranch();
    const u = await newCashier([x1, x2]);
    const s = await sessionOn(u.username, x1);
    const before = await liveOnBranch(x1);
    const missing = await http('DELETE', `/branches/${randomUUID()}`, { token: ownerToken, businessId: bizA });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await liveOnBranch(x1)).toBe(before);
    expect((await invite(s.accessToken, x1)).status).toBe(200);
  });

  it('a switch racing the deletion of its target branch leaves no live session on the deleted branch (both orders, then 15 free rounds)', async () => {
    for (const order of ['switch-first', 'delete-first'] as const) {
      const x1 = await freshBranch(); const x2 = await freshBranch();
      const u = await newCashier([x1, x2]);
      const s = await sessionOn(u.username, x1);
      const sw = () => switchTo(s.refreshToken, x2, x1);
      const dl = () => del(x2);
      const [a, b] = order === 'switch-first' ? await parked(sw, dl) : await parked(dl, sw);
      const [sres, dres] = order === 'switch-first' ? [a, b] : [b, a];
      expect((dres as { status: number }).status, order).toBe(204);
      if (order === 'delete-first') expect((sres as { status: number }).status, order).toBeGreaterThanOrEqual(400);
      expect(await liveOnBranch(x2), `${order}: live session on deleted branch`).toBe(0);
    }
    for (let i = 0; i < 15; i++) {
      const x1 = await freshBranch(); const x2 = await freshBranch();
      const u = await newCashier([x1, x2]);
      const s = await sessionOn(u.username, x1);
      await Promise.all([switchTo(s.refreshToken, x2, x1), del(x2)]);
      expect(await liveOnBranch(x2), `round ${i}`).toBe(0);
    }
  });
});
