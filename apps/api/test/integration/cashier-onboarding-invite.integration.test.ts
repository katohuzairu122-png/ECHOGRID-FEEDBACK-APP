import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { decode, sign } from 'hono/jwt';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { authRoutes } from '../../src/auth/auth.routes';
import { cashierAccountRoutes } from '../../src/cashier-accounts/cashier-accounts.routes';
import { customerMembershipRoutes } from '../../src/customer-relationships/customer-membership.routes';
import { loyaltyRoutes } from '../../src/loyalty/loyalty.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { signOnboardingInvite } from '../../src/customer-relationships/onboarding-attribution';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';

/**
 * CASHIER-AUTH-02D invitation ISSUER (the one owner-authorised addition to the cashier route allow-list), against real PostgreSQL,
 * the real middleware, the real customer acceptance route and the real join service. Covers: what the route trusts (only the verified
 * cashier token and its live session), refusals, what the invitation contains, single use and replay, invalidation by every kind of
 * session or authority change, rate limiting, audit, tenant isolation and that nothing about a customer is ever in the invitation.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Invitation issuer tests need a loopback PostgreSQL database.');
}

const SECRET = 'invite-fixture-access-secret';
const REFRESH_SECRET = 'invite-fixture-refresh-secret';
const CUSTOMER_SECRET = 'invite-fixture-customer-secret';
const QR_SECRET = 'invite-fixture-qr-secret';
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

// The lookup limiter is replaceable per test so the rate-limit behaviour can be asserted without sleeping.
let lookupLimiter: { limit: (o: { key: string }) => Promise<{ success: boolean }> } = allow;
const limiterKeys: string[] = [];

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/cashier-accounts', cashierAccountRoutes);
app.route('/api/v1/customer-memberships', customerMembershipRoutes);
app.route('/api/v1/loyalty', loyaltyRoutes);
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
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET,
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET, QR_TOKEN_SECRET: QR_SECRET, WEB_BASE_URL: 'https://web.example.test',
    PASSWORD_HASHER: hasherNamespace, AUTH_RATE_LIMITER: allow, API_RATE_LIMITER: allow, PUBLIC_RATE_LIMITER: allow,
    LOOKUP_RATE_LIMITER: { limit: async (o: { key: string }) => { limiterKeys.push(o.key); return lookupLimiter.limit(o); } },
    CUSTOMER_API_RATE_LIMITER: allow, JOBS: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Bindings;
  const response = await app.request(`/api/v1${path}`, {
    method, headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await response.text();
  return { status: response.status, ...(text ? (JSON.parse(text) as Envelope) : {}) };
}

describe.skipIf(!databaseUrl)('CASHIER-AUTH-02D onboarding invitation issuer (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const PW = 'an-owner-password-1';
  const cashierPw = 'cashier-pass-1';
  let bizA: string; let bizB: string; let a1: string; let a2: string; let a3: string; let b1: string;
  let ownerToken: string; let ownerEmail: string; let ownerBId: string; let ownerBToken: string;
  let code = ''; let codeB = '';
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
  const newCashier = async (mode: 'single' | 'multiple', branchIds: string[]) => {
    const username = `iv${run.slice(0, 6)}x${++seq}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const r = await admin('POST', '/cashier-accounts', { username, displayName: `Invite ${username}`, accessMode: mode, branchIds, password: cashierPw });
    expect(r.status, JSON.stringify(r)).toBe(201);
    code = r.data.cashierCode;
    return { id: r.data.account.id as string, username };
  };
  type Session = { accessToken: string; refreshToken: string; session: { branchId: string | null } };
  const sessionOn = async (username: string, branchId: string): Promise<Session> => {
    const l = await http('POST', '/auth/cashier/managed-login', { body: { businessCode: code, username, password: cashierPw } });
    if (l.data?.status === 'authenticated') return l.data as Session;
    const s = await http('POST', '/auth/cashier/session', { body: { ticket: l.data.ticket, businessId: bizA, branchId } });
    expect(s.status, JSON.stringify(s)).toBe(200);
    return s.data as Session;
  };
  // CASHIER-FINAL-RECONCILIATION: the cashier-facing issuer was withdrawn (Invite Customers is not a cashier function), so these
  // acceptance tests mint the invitation directly with the same signer, bound to the cashier session carried by a real cashier token.
  const issue = async (token: string): Promise<{ status: number; data: { inviteToken: string; branchId: string } }> => {
    const claims = decode(token).payload as { sub: string; sid: string; bid: string; brid: string };
    const invite = await signOnboardingInvite({ cashierUserId: claims.sub, sessionId: claims.sid, businessId: claims.bid, branchId: claims.brid }, SECRET);
    return { status: 200, data: { inviteToken: invite.token, branchId: claims.brid } };
  };
  const switchTo = (refreshToken: string, branchId: string, fromBranchId?: string) =>
    http('POST', '/auth/cashier/switch-branch', { body: { refreshToken, branchId, ...(fromBranchId ? { fromBranchId } : {}) } });
  let phoneSeq = 0;
  const newCustomer = async () => {
    const id = (await repos.customers.create({ phone: `+1559${run.replace(/\D/g, '').padEnd(8, '3').slice(0, 5)}${String(++phoneSeq).padStart(2, '0')}` })).id;
    return { id, token: await signCustomerAccessToken(id, CUSTOMER_SECRET) };
  };
  const accept = (customerToken: string, inviteToken: string) =>
    http('POST', '/customer-memberships/join-assisted', { token: customerToken, body: { inviteToken, consentAccepted: true, consentVersion: 'v1' } });
  const events = (customerId: string, businessId = bizA) => q(`SELECT * FROM customer_onboarding_events WHERE customer_id = $1 AND business_id = $2`, [customerId, businessId]);
  const memberships = (customerId: string, businessId = bizA) => q(`SELECT 1 FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [customerId, businessId]);

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
    ownerEmail = `iv-owner-${run}@example.test`;
    const mkUser = async (email: string, label: string) => (await repos.users.create({
      email, fullName: label, passwordHash: await pbkdf2Hash(PW, 1000), status: 'active',
    })).id;
    const ownerId = await mkUser(ownerEmail, 'owner');
    ownerBId = await mkUser(`iv-ownerb-${run}@example.test`, 'ownerb');
    bizA = (await repos.businesses.create({ name: 'Invite A', slug: `iv-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: 'Invite B', slug: `iv-b-${run}` })).id;
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
    ownerBToken = await signAccessToken(ownerBId, SECRET);
    await newCashier('multiple', [a1, a2, a3]);
    void b1; void codeB;
  });
  afterAll(async () => { await client?.end(); });

  describe('the cashier-facing issuer is withdrawn', () => {
    it('a cashier access token is refused on the issuer before any handler runs, whatever the method or body', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      for (const method of ['POST', 'GET', 'PUT'] as const) {
        const r = await http(method, '/loyalty/actions/onboarding-invite', { token: s.accessToken });
        expect(r.status, method).toBe(403);
        expect(r.error?.code, method).toBe('CASHIER_ROUTE_DENIED');
      }
    });
  });

  describe('refusals', () => {
    it('a cashier token cannot reach the customer acceptance endpoint (customer authentication only)', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      const invite = await issue(s.accessToken);
      const res = await http('POST', '/customer-memberships/join-assisted', { token: s.accessToken, body: { inviteToken: invite.data.inviteToken, consentAccepted: true } });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('single use, replay and expiry', () => {
    it('accepting twice as the same customer is idempotent (one membership, one event); a second customer is refused and leaves no trace', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      const invite = (await issue(s.accessToken)).data.inviteToken as string;
      const first = await newCustomer(); const second = await newCustomer();
      expect((await accept(first.token, invite)).status).toBe(201);
      expect((await accept(first.token, invite)).status).toBe(201);
      expect(await events(first.id)).toHaveLength(1);
      const replay = await accept(second.token, invite);
      expect(replay.status).toBe(409);
      expect(replay.error?.code).toBe('ONBOARDING_INVITE_USED');
      expect(await memberships(second.id)).toHaveLength(0);
      expect(await events(second.id)).toHaveLength(0);
    });

    it('an expired invitation is refused', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      const real = (await issue(s.accessToken)).data.inviteToken as string;
      const p = decode(real).payload as Record<string, unknown>;
      const expired = await sign({ ...p, iat: 1, exp: 2 }, SECRET, 'HS256');
      const customer = await newCustomer();
      const res = await accept(customer.token, expired);
      expect(res.status).toBe(400);
      expect(res.error?.code).toBe('ONBOARDING_INVITE_INVALID');
      expect(await memberships(customer.id)).toHaveLength(0);
    });

    it('a tampered invitation (claims edited, signature kept) is refused', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const real = (await issue(s.accessToken)).data.inviteToken as string;
      const [h, p, sig] = real.split('.');
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
      claims.brid = a2;
      const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
      const customer = await newCustomer();
      expect((await accept(customer.token, forged)).status).toBe(400);
      expect(await events(customer.id)).toHaveLength(0);
    });
  });

  describe('the invitation stops working when the issuing authority changes', () => {
    const scenarios: Array<[string, (u: { id: string; username: string }, s: Session) => Promise<void>]> = [
      ['the cashier signs out', async (_u, s) => { expect((await http('POST', '/auth/cashier/logout', { body: { refreshToken: s.refreshToken } })).status).toBe(204); }],
      ['the cashier switches branch', async (_u, s) => { expect((await switchTo(s.refreshToken, a2, a1)).status).toBe(200); }],
      ['the branch is removed from the cashier', async (u) => { expect((await admin('PUT', `/cashier-accounts/${u.id}/branches`, { accessMode: 'multiple', branchIds: [a2, a3] })).status).toBe(200); }],
      ['the sessions are revoked', async (u) => { expect((await admin('POST', `/cashier-accounts/${u.id}/revoke-sessions`)).status).toBe(200); }],
      ['the cashier is disabled', async (u) => { expect((await admin('POST', `/cashier-accounts/${u.id}/disable`)).status).toBe(200); }],
      ['the credential is reset', async (u) => { expect((await admin('POST', `/cashier-accounts/${u.id}/reset-credential`, { password: 'owner-chosen-reset-1' })).status).toBe(200); }],
    ];
    for (const [name, change] of scenarios) {
      it(`${name}: an invitation issued before it is refused afterwards and nothing is recorded`, async () => {
        const u = await newCashier('multiple', [a1, a2, a3]);
        const s = await sessionOn(u.username, a1);
        const invite = (await issue(s.accessToken)).data.inviteToken as string;
        await change(u, s);
        const customer = await newCustomer();
        const res = await accept(customer.token, invite);
        expect(res.status, JSON.stringify(res)).toBe(409);
        expect(res.error?.code).toBe('ONBOARDING_INVITE_INVALID');
        expect(await memberships(customer.id)).toHaveLength(0);
        expect(await events(customer.id)).toHaveLength(0);
      });
    }

    it('the branch is soft-deleted or archived after issuing (independent review M-1): the invitation is refused and nothing is attributed to it', async () => {
      for (const change of [`UPDATE branches SET is_deleted = true, deleted_at = now() WHERE id = $1`, `UPDATE branches SET status = 'archived' WHERE id = $1`]) {
        const branch = (await repos.branches.create({ businessId: bizA, name: `Gone ${++seq}`, slug: `gone${run.slice(0, 4)}${seq}` })).id;
        const u = await newCashier('single', [branch]);
        const s = await sessionOn(u.username, branch);
        const invite = (await issue(s.accessToken)).data.inviteToken as string;
        await q(change, [branch]);
        const customer = await newCustomer();
        const res = await accept(customer.token, invite);
        expect(res.status, `${change}: ${JSON.stringify(res)}`).toBe(409);
        expect(res.error?.code).toBe('ONBOARDING_INVITE_INVALID');
        expect(await memberships(customer.id)).toHaveLength(0);
        expect(await events(customer.id)).toHaveLength(0);
      }
    });

    it('a soft-deleted cashier user, or a session row that does not belong to the invitation\'s business, is refused (independent review L-3)', async () => {
      const u1 = await newCashier('single', [a1]);
      const s1 = await sessionOn(u1.username, a1);
      const invite1 = (await issue(s1.accessToken)).data.inviteToken as string;
      await q(`UPDATE users SET is_deleted = true WHERE id = $1`, [u1.id]);
      const c1 = await newCustomer();
      expect((await accept(c1.token, invite1)).status).toBe(409);
      expect(await events(c1.id)).toHaveLength(0);
      const u2 = await newCashier('single', [a1]);
      const s2 = await sessionOn(u2.username, a1);
      const invite2 = (await issue(s2.accessToken)).data.inviteToken as string;
      await q(`UPDATE refresh_tokens SET business_id = $2 WHERE user_id = $1 AND client = 'cashier' AND revoked_at IS NULL`, [u2.id, bizB]);
      const c2 = await newCustomer();
      expect((await accept(c2.token, invite2)).status).toBe(409);
      expect(await events(c2.id)).toHaveLength(0);
    });

    it('after a switch the cashier issues a NEW invitation from the new branch, attributed to it; the old token, now stale, still works for no one', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const stale = (await issue(s.accessToken)).data.inviteToken as string;
      const sw = await switchTo(s.refreshToken, a2, a1);
      expect(sw.status).toBe(200);
      expect((await http('GET', '/auth/me', { token: s.accessToken })).status).toBe(401); // the pre-switch access token is dead
      const fresh = await issue(sw.data.accessToken);
      expect(fresh.data.branchId).toBe(a2);
      const customer = await newCustomer();
      expect((await accept(customer.token, stale)).status).toBe(409);
      expect((await accept(customer.token, fresh.data.inviteToken)).status).toBe(201);
      expect((await events(customer.id))[0]).toMatchObject({ branch_id: a2, cashier_user_id: u.id });
    });
  });

  describe('tenant isolation', () => {
    it('an invitation names its own business only: accepting it never creates anything in another business', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      const invite = (await issue(s.accessToken)).data.inviteToken as string;
      const customer = await newCustomer();
      expect((await accept(customer.token, invite)).status).toBe(201);
      expect(await memberships(customer.id, bizA)).toHaveLength(1);
      expect(await memberships(customer.id, bizB)).toHaveLength(0);
      expect(await events(customer.id, bizB)).toHaveLength(0);
    });
  });

  describe('the customer preview (what is shown before consenting)', () => {
    const preview = (customerToken: string, inviteToken: string) =>
      http('POST', '/customer-memberships/join-assisted/preview', { token: customerToken, body: { inviteToken } });

    it('shows the business and branch and a ready state, nothing about the cashier, and consumes nothing', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      const invite = (await issue(s.accessToken)).data.inviteToken as string;
      const customer = await newCustomer();
      const res = await preview(customer.token, invite);
      expect(res.status, JSON.stringify(res)).toBe(200);
      expect(res.data).toMatchObject({ status: 'ready', businessName: 'Invite A', branchName: 'A1', businessId: bizA });
      expect(Object.keys(res.data).sort()).toEqual(['branchName', 'businessId', 'businessName', 'expiresAt', 'status']);
      expect(JSON.stringify(res)).not.toContain(u.id);
      expect(JSON.stringify(res)).not.toContain(u.username);
      expect(await memberships(customer.id)).toHaveLength(0); // previewing is read-only
      expect(await events(customer.id)).toHaveLength(0);
      expect((await accept(customer.token, invite)).status).toBe(201); // and the invitation is still usable afterwards
    });

    it('reports already_member for a current member and used once another customer has accepted it', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      const invite = (await issue(s.accessToken)).data.inviteToken as string;
      const first = await newCustomer(); const second = await newCustomer();
      expect((await accept(first.token, invite)).status).toBe(201);
      expect((await preview(first.token, invite)).data.status).toBe('already_member');
      expect((await preview(second.token, invite)).data.status).toBe('used');
    });

    it('refuses an invalid, expired or foreign token with the same generic error, and requires customer authentication', async () => {
      const customer = await newCustomer();
      for (const bad of ['not-a-token', 'a.b.c']) {
        const res = await preview(customer.token, bad);
        expect(res.status).toBe(400);
        expect(res.error?.code).toBe('ONBOARDING_INVITE_INVALID');
      }
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      expect([401, 403]).toContain((await http('POST', '/customer-memberships/join-assisted/preview', { body: { inviteToken: 'x' } })).status);
      expect([401, 403]).toContain((await http('POST', '/customer-memberships/join-assisted/preview', { token: s.accessToken, body: { inviteToken: 'x' } })).status);
    });

    it('a branch that was deleted or archived after issuing is refused at preview as well', async () => {
      const branch = (await repos.branches.create({ businessId: bizA, name: `Pv ${++seq}`, slug: `pv${run.slice(0, 4)}${seq}` })).id;
      const u = await newCashier('single', [branch]);
      const s = await sessionOn(u.username, branch);
      const invite = (await issue(s.accessToken)).data.inviteToken as string;
      await q(`UPDATE branches SET status = 'archived' WHERE id = $1`, [branch]);
      const res = await preview((await newCustomer()).token, invite);
      expect(res.status).toBe(400);
      expect(res.error?.code).toBe('ONBOARDING_INVITE_INVALID');
    });
  });
});
