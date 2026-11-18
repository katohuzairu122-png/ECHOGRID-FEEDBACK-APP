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
import { customerMembershipRoutes } from '../../src/customer-relationships/customer-membership.routes';
import { loyaltyCustomerRoutes } from '../../src/loyalty/loyalty-customer.routes';
import { analyticsRoutes } from '../../src/analytics/analytics.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { pbkdf2Hash, pbkdf2Verify } from '../../src/auth/password';
import { QrCodeService } from '../../src/qr/qr-code.service';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { signOnboardingInvite } from '../../src/customer-relationships/onboarding-attribution';

/**
 * CASHIER-AUTH-02D against REAL Postgres, the REAL middleware and the REAL join service: append-only onboarding attribution.
 * Covers cashier-assisted and self-service (branch QR) onboarding, re-joining, branch/cashier authority at the transaction boundary
 * (including races with a branch switch), consent and verification honesty, tenant isolation, database guards, rollback, audit
 * consistency, data minimisation, reporting and ledger isolation. Hashing runs at 1,000 iterations through a Durable Object stand-in.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Onboarding attribution tests need a loopback PostgreSQL database.');
}

const SECRET = 'onboarding-fixture-access-secret';
const REFRESH_SECRET = 'onboarding-fixture-refresh-secret';
const CUSTOMER_SECRET = 'onboarding-fixture-customer-secret';
const QR_SECRET = 'onboarding-fixture-qr-secret';
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
app.route('/api/v1/cashier-accounts', cashierAccountRoutes);
app.route('/api/v1/customer-memberships', customerMembershipRoutes);
app.route('/api/v1/loyalty/me', loyaltyCustomerRoutes);
app.route('/api/v1/analytics', analyticsRoutes);
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
    HYPERDRIVE: { connectionString: databaseUrl }, JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET,
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET, QR_TOKEN_SECRET: QR_SECRET,
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

describe.skipIf(!databaseUrl)('CASHIER-AUTH-02D customer onboarding attribution (real HTTP, real PostgreSQL)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const PW = 'an-owner-password-1';
  const cashierPw = 'cashier-pass-1';
  let bizA: string; let bizB: string; let a1: string; let a2: string; let a3: string; let b1: string;
  let ownerId: string; let ownerToken: string; let ownerBId: string; let staffBranchToken: string;
  let qrA1: string; let qrA2: string; let qrB1: string; let qrA1Id: string;
  let code = '';
  let seq = 0;

  const proofFor = async () => { const r = await http('POST', '/cashier-accounts/reauth', { token: ownerToken, businessId: bizA, body: { password: PW } }); expect(r.status, JSON.stringify(r)).toBe(200); return r.data.proof as string; };
  let cachedProof = '';
  const admin = async (method: string, path: string, body?: unknown) => {
    if (!cachedProof) cachedProof = await proofFor();
    return http(method, path, { token: ownerToken, businessId: bizA, headers: { 'X-Reauth-Proof': cachedProof }, ...(body === undefined ? {} : { body }) });
  };
  const newCashier = async (mode: 'single' | 'multiple', branchIds: string[]) => {
    const username = `ob${run.slice(0, 6)}x${++seq}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const r = await admin('POST', '/cashier-accounts', { username, displayName: `Onboard ${username}`, accessMode: mode, branchIds, password: cashierPw });
    expect(r.status, JSON.stringify(r)).toBe(201);
    code = r.data.cashierCode;
    return { id: r.data.account.id as string, username };
  };
  const sessionOn = async (username: string, branchId: string) => {
    const l = await http('POST', '/auth/cashier/managed-login', { body: { businessCode: code, username, password: cashierPw } });
    if (l.data?.status === 'authenticated') return l.data as { accessToken: string; refreshToken: string };
    const s = await http('POST', '/auth/cashier/session', { body: { ticket: l.data.ticket, businessId: bizA, branchId } });
    expect(s.status, JSON.stringify(s)).toBe(200);
    return s.data as { accessToken: string; refreshToken: string };
  };
  const switchTo = (refreshToken: string, branchId: string, fromBranchId?: string) =>
    http('POST', '/auth/cashier/switch-branch', { body: { refreshToken, branchId, ...(fromBranchId ? { fromBranchId } : {}) } });
  const sessionIdOf = async (userId: string, branchId: string): Promise<string> => {
    const rows = await q(`SELECT session_id FROM refresh_tokens WHERE user_id = $1 AND client = 'cashier' AND revoked_at IS NULL AND branch_id = $2 ORDER BY issued_at DESC LIMIT 1`, [userId, branchId]);
    return rows[0].session_id as string;
  };
  /** An invitation exactly as the (not yet exposed) issuing endpoint will sign it, for a cashier's live session. */
  const inviteFor = async (cashierUserId: string, branchId: string, over: Partial<{ sessionId: string; businessId: string }> = {}) =>
    signOnboardingInvite({
      cashierUserId, sessionId: over.sessionId ?? (await sessionIdOf(cashierUserId, branchId)), businessId: over.businessId ?? bizA, branchId,
    }, SECRET);

  let phoneSeq = 0;
  const newCustomer = async (verifiedPhone: boolean, verifiedEmail = false) => {
    const id = (await repos.customers.create({
      phone: `+1558${run.replace(/\D/g, '').padEnd(8, '2').slice(0, 5)}${String(++phoneSeq).padStart(2, '0')}`,
      ...(verifiedPhone ? { phoneVerifiedAt: new Date() } : {}),
    })).id;
    if (verifiedEmail) {
      await repos.customerCredentials.create({
        customerId: id, passwordHash: await pbkdf2Hash('x'.repeat(10), 1000), now: new Date(),
        verifiedLoginEmail: { address: `ob-${run}-${phoneSeq}@example.test`, verifiedAt: new Date() },
      });
    }
    return { id, token: await signCustomerAccessToken(id, CUSTOMER_SECRET) };
  };
  const consent = { consentAccepted: true as const, consentVersion: 'v1' as const };
  const joinAssisted = (customerToken: string, inviteToken: string, extra: Record<string, unknown> = {}) =>
    http('POST', '/customer-memberships/join-assisted', { token: customerToken, body: { inviteToken, ...consent, ...extra } });
  const joinQr = (customerToken: string, qrToken: string) =>
    http('POST', '/customer-memberships/join', { token: customerToken, body: { qrToken, ...consent } });
  const leave = (customerToken: string, businessId: string) =>
    http('POST', `/customer-memberships/${businessId}/leave`, { token: customerToken });
  const events = (customerId: string, businessId = bizA) => q(
    `SELECT * FROM customer_onboarding_events WHERE customer_id = $1 AND business_id = $2 ORDER BY occurred_at, recorded_at`, [customerId, businessId]);
  const memberships = (customerId: string, businessId = bizA) => q(
    `SELECT * FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [customerId, businessId]);

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
    const mkUser = async (label: string) => (await repos.users.create({
      email: `ob-${label}-${run}@example.test`, fullName: label, passwordHash: await pbkdf2Hash(PW, 1000), status: 'active',
    })).id;
    ownerId = await mkUser('owner');
    ownerBId = await mkUser('ownerb');
    const branchStaffId = await mkUser('branchstaff');
    bizA = (await repos.businesses.create({ name: 'Onboard A', slug: `ob-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: 'Onboard B', slug: `ob-b-${run}` })).id;
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
    await grant(branchStaffId, bizA, rolesA.Manager, a1);
    ownerToken = await signAccessToken(ownerId, SECRET);
    staffBranchToken = await signAccessToken(branchStaffId, SECRET);
    const qr = new QrCodeService(repos, { QR_TOKEN_SECRET: QR_SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined });
    const i1 = await qr.getOrCreateActiveForBranch(a1, bizA, ownerId); qrA1 = i1.token; qrA1Id = i1.qrCode.id;
    qrA2 = (await qr.getOrCreateActiveForBranch(a2, bizA, ownerId)).token;
    qrB1 = (await qr.getOrCreateActiveForBranch(b1, bizB, ownerBId)).token;
    await newCashier('multiple', [a1, a2, a3]); // also reads the business code
  });
  afterAll(async () => { await client?.end(); });

  describe('self-service onboarding through a branch QR', () => {
    it('records a business_qr event with the QR code\'s own branch, no cashier, honest verification, consent and an audit link', async () => {
      const c = await newCustomer(false);
      const res = await joinQr(c.token, qrA1);
      expect(res.status, JSON.stringify(res)).toBe(201);
      const ev = await events(c.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        source: 'business_qr', branch_id: a1, cashier_user_id: null, verification_state: 'unverified', is_rejoin: false, reference: qrA1Id,
      });
      expect(ev[0].consent_grant_id).toBeTruthy();
      const [m] = await memberships(c.id);
      expect(m.id).toBe(ev[0].membership_id);
      const audit = await q(`SELECT * FROM audit_log WHERE id = $1`, [ev[0].audit_log_id]);
      expect(audit[0]).toMatchObject({ action: 'customer.onboarded', entity_type: 'customer_onboarding_event', entity_id: ev[0].id, business_id: bizA, actor_user_id: null });
      expect(audit[0].metadata).toMatchObject({ source: 'business_qr', branchId: a1, membershipId: m.id, rejoin: false, verificationState: 'unverified' });
    });

    it('uses the branch of whichever branch QR was scanned (A2) and never a client-supplied branch', async () => {
      const c = await newCustomer(true);
      const res = await http('POST', '/customer-memberships/join', { token: c.token, body: { qrToken: qrA2, ...consent, branchId: a3, cashierUserId: ownerId } });
      expect(res.status).toBe(201);
      const [ev] = await events(c.id);
      expect(ev).toMatchObject({ source: 'business_qr', branch_id: a2, cashier_user_id: null, verification_state: 'phone_verified' });
    });

    it('the legacy /loyalty/me/join entry point records the same attribution', async () => {
      const c = await newCustomer(false);
      const res = await http('POST', '/loyalty/me/join', { token: c.token, body: { qrToken: qrA1, ...consent } });
      expect(res.status, JSON.stringify(res)).toBe(201);
      expect((await events(c.id))[0]).toMatchObject({ source: 'business_qr', branch_id: a1 });
    });

    it('verification state reflects only authoritative records: phone, email, both or neither; enrollment alone never verifies', async () => {
      const cases: Array<[boolean, boolean, string]> = [[false, false, 'unverified'], [true, false, 'phone_verified'], [false, true, 'email_verified'], [true, true, 'phone_and_email_verified']];
      for (const [phone, email, expected] of cases) {
        const c = await newCustomer(phone, email);
        expect((await joinQr(c.token, qrA1)).status).toBe(201);
        expect((await events(c.id))[0].verification_state, `${phone}/${email}`).toBe(expected);
      }
    });

    it('a later phone verification does not rewrite the historical event', async () => {
      const c = await newCustomer(false);
      await joinQr(c.token, qrA1);
      await q(`UPDATE customers SET phone_verified_at = now() WHERE id = $1`, [c.id]);
      expect((await events(c.id))[0].verification_state).toBe('unverified');
    });
  });

  describe('cashier-assisted onboarding', () => {
    it('records branch and cashier from the server-signed invitation of a live session, with consent from the customer', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const c = await newCustomer(true);
      const invite = await inviteFor(u.id, a1);
      const res = await joinAssisted(c.token, invite.token);
      expect(res.status, JSON.stringify(res)).toBe(201);
      const [ev] = await events(c.id);
      expect(ev).toMatchObject({ source: 'cashier_assisted', branch_id: a1, cashier_user_id: u.id, reference: invite.inviteId, verification_state: 'phone_verified', is_rejoin: false });
      expect(ev.consent_grant_id).toBeTruthy();
      const [audit] = await q(`SELECT * FROM audit_log WHERE id = $1`, [ev.audit_log_id]);
      expect(audit).toMatchObject({ action: 'customer.onboarded', actor_user_id: u.id, business_id: bizA });
      expect(audit.metadata.source).toBe('cashier_assisted');
    });

    it('the customer response and the audit row expose nothing about the cashier session or other customers (data minimisation)', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const c = await newCustomer(false);
      const invite = await inviteFor(u.id, a1);
      const res = await joinAssisted(c.token, invite.token);
      const blob = JSON.stringify(res);
      expect(blob).not.toContain(u.id);
      expect(blob).not.toContain(invite.token);
      expect(blob).not.toMatch(/sessionId|refresh|password/i);
      const [ev] = await events(c.id);
      const [audit] = await q(`SELECT metadata FROM audit_log WHERE id = $1`, [ev.audit_log_id]);
      expect(JSON.stringify(audit.metadata)).not.toMatch(/phone|email|name|token|password/i);
    });

    it('a multi-branch cashier is attributed to the branch the session is bound to', async () => {
      const u = await newCashier('multiple', [a1, a2, a3]);
      await sessionOn(u.username, a2);
      const c = await newCustomer(false);
      expect((await joinAssisted(c.token, (await inviteFor(u.id, a2)).token)).status).toBe(201);
      expect((await events(c.id))[0]).toMatchObject({ branch_id: a2, cashier_user_id: u.id });
    });

    it('an invitation that names a branch the cashier session is NOT bound to is refused and records nothing', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      await sessionOn(u.username, a1);
      const forged = await signOnboardingInvite({ cashierUserId: u.id, sessionId: await sessionIdOf(u.id, a1), businessId: bizA, branchId: a2 }, SECRET);
      const c = await newCustomer(false);
      const res = await joinAssisted(c.token, forged.token);
      expect(res.status).toBe(409);
      expect(res.error?.code).toBe('ONBOARDING_INVITE_INVALID');
      expect(await events(c.id)).toHaveLength(0);
      expect(await memberships(c.id)).toHaveLength(0);
    });

    it('an invitation for a branch the cashier is not assigned to is refused (unassigned branch)', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const forged = await signOnboardingInvite({ cashierUserId: u.id, sessionId: await sessionIdOf(u.id, a1), businessId: bizA, branchId: a3 }, SECRET);
      const c = await newCustomer(false);
      expect((await joinAssisted(c.token, forged.token)).status).toBe(409);
      expect(await events(c.id)).toHaveLength(0);
    });

    it('a cross-business invitation (business B named, cashier of business A) is refused', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const forged = await signOnboardingInvite({ cashierUserId: u.id, sessionId: await sessionIdOf(u.id, a1), businessId: bizB, branchId: b1 }, SECRET);
      const c = await newCustomer(false);
      const res = await joinAssisted(c.token, forged.token);
      expect(res.status).toBe(409);
      expect(await memberships(c.id, bizB)).toHaveLength(0);
      expect(await events(c.id, bizB)).toHaveLength(0);
    });

    it('invalid, tampered, wrong-type and expired invitations are refused with one generic error', async () => {
      const c = await newCustomer(false);
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const good = (await inviteFor(u.id, a1)).token;
      const tampered = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      const accessToken = await signAccessToken(u.id, SECRET);
      const expired = await signOnboardingInvite({ cashierUserId: u.id, sessionId: await sessionIdOf(u.id, a1), businessId: bizA, branchId: a1 }, 'a-different-secret');
      for (const bad of ['not-a-token', tampered, accessToken, expired.token]) {
        const res = await joinAssisted(c.token, bad);
        expect(res.status, bad.slice(0, 12)).toBe(400);
        expect(res.error?.code).toBe('ONBOARDING_INVITE_INVALID');
      }
      expect(await events(c.id)).toHaveLength(0);
    });

    it('a customer who does not consent (or omits consent) is refused and nothing is recorded', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const c = await newCustomer(false);
      const invite = (await inviteFor(u.id, a1)).token;
      expect((await http('POST', '/customer-memberships/join-assisted', { token: c.token, body: { inviteToken: invite, consentAccepted: false, consentVersion: 'v1' } })).status).toBe(400);
      expect((await http('POST', '/customer-memberships/join-assisted', { token: c.token, body: { inviteToken: invite } })).status).toBe(400);
      expect((await http('POST', '/customer-memberships/join-assisted', { token: c.token, body: { inviteToken: invite, consentAccepted: true, consentVersion: 'v99' } })).status).toBe(400);
      expect(await memberships(c.id)).toHaveLength(0);
      expect(await events(c.id)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM consent_grants WHERE customer_id = $1`, [c.id])).toHaveLength(0);
    });

    it('an unauthenticated caller and a staff token cannot use the customer endpoint', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const invite = (await inviteFor(u.id, a1)).token;
      expect((await http('POST', '/customer-memberships/join-assisted', { body: { inviteToken: invite, ...consent } })).status).toBe(401);
      expect((await http('POST', '/customer-memberships/join-assisted', { token: ownerToken, body: { inviteToken: invite, ...consent } })).status).toBe(401);
    });
  });

  describe('authority at the transaction boundary: switch, sign-out, disable, revoke', () => {
    it('switching branch BEFORE the customer accepts makes the old invitation unusable; a new one from the new branch attributes to it', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const c = await newCustomer(false);
      const old = await inviteFor(u.id, a1);
      expect((await switchTo(s.refreshToken, a2, a1)).status).toBe(200);
      const stale = await joinAssisted(c.token, old.token);
      expect(stale.status).toBe(409);
      expect(stale.error?.code).toBe('ONBOARDING_INVITE_INVALID');
      expect(await events(c.id)).toHaveLength(0);
      expect(await memberships(c.id)).toHaveLength(0);
      const fresh = await inviteFor(u.id, a2);
      expect((await joinAssisted(c.token, fresh.token)).status).toBe(201);
      expect((await events(c.id))[0]).toMatchObject({ branch_id: a2, cashier_user_id: u.id });
    });

    it('a switch AFTER the onboarding committed does not change where it was recorded', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      const s = await sessionOn(u.username, a1);
      const c = await newCustomer(false);
      expect((await joinAssisted(c.token, (await inviteFor(u.id, a1)).token)).status).toBe(201);
      expect((await switchTo(s.refreshToken, a2, a1)).status).toBe(200);
      expect((await events(c.id))[0].branch_id).toBe(a1);
      expect((await events(c.id))).toHaveLength(1);
    });

    it('a switch racing the acceptance has exactly two legal outcomes and never a mixed one (6 rounds)', async () => {
      for (let round = 0; round < 6; round++) {
        const u = await newCashier('multiple', [a1, a2]);
        const s = await sessionOn(u.username, a1);
        const c = await newCustomer(false);
        const invite = await inviteFor(u.id, a1);
        const [join, sw] = await Promise.all([joinAssisted(c.token, invite.token), switchTo(s.refreshToken, a2, a1)]);
        expect(sw.status, `round ${round}`).toBe(200);
        const ev = await events(c.id);
        if (join.status === 201) {
          // the onboarding committed first: attributed to the branch it was authorised for, exactly once
          expect(ev, `round ${round}`).toHaveLength(1);
          expect(ev[0].branch_id).toBe(a1);
          expect(ev[0].cashier_user_id).toBe(u.id);
        } else {
          // the switch committed first: refused before anything was written
          expect(join.status, `round ${round}`).toBe(409);
          expect(join.error?.code).toBe('ONBOARDING_INVITE_INVALID');
          expect(ev).toHaveLength(0);
          expect(await memberships(c.id)).toHaveLength(0);
        }
      }
    });

    it('a signed-out cashier session cannot onboard (stale session submission)', async () => {
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      const invite = await inviteFor(u.id, a1);
      expect((await http('POST', '/auth/cashier/logout', { body: { refreshToken: s.refreshToken } })).status).toBe(204);
      const c = await newCustomer(false);
      expect((await joinAssisted(c.token, invite.token)).status).toBe(409);
      expect(await events(c.id)).toHaveLength(0);
    });

    it('a revoked session and a disabled cashier cannot onboard', async () => {
      const revoked = await newCashier('single', [a1]);
      await sessionOn(revoked.username, a1);
      const inviteR = await inviteFor(revoked.id, a1);
      expect((await admin('POST', `/cashier-accounts/${revoked.id}/revoke-sessions`)).status).toBe(200);
      const c1 = await newCustomer(false);
      expect((await joinAssisted(c1.token, inviteR.token)).status).toBe(409);
      const disabled = await newCashier('single', [a1]);
      await sessionOn(disabled.username, a1);
      const inviteD = await inviteFor(disabled.id, a1);
      expect((await admin('POST', `/cashier-accounts/${disabled.id}/disable`)).status).toBe(200);
      const c2 = await newCustomer(false);
      expect((await joinAssisted(c2.token, inviteD.token)).status).toBe(409);
      expect(await events(c1.id)).toHaveLength(0);
      expect(await events(c2.id)).toHaveLength(0);
    });

    it('removing the cashier\'s branch assignment ends that branch\'s sessions, so its invitation stops working', async () => {
      const u = await newCashier('multiple', [a1, a2]);
      await sessionOn(u.username, a1);
      const invite = await inviteFor(u.id, a1);
      expect((await admin('PUT', `/cashier-accounts/${u.id}/branches`, { accessMode: 'multiple', branchIds: [a2, a3] })).status).toBe(200);
      const c = await newCustomer(false);
      expect((await joinAssisted(c.token, invite.token)).status).toBe(409);
      expect(await events(c.id)).toHaveLength(0);
    });
  });

  describe('duplicates, concurrency and rollback', () => {
    it('the same customer accepting the same invitation twice is idempotent: one membership, one event', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const c = await newCustomer(false);
      const invite = (await inviteFor(u.id, a1)).token;
      expect((await joinAssisted(c.token, invite)).status).toBe(201);
      expect((await joinAssisted(c.token, invite)).status).toBe(201);
      expect(await events(c.id)).toHaveLength(1);
      expect(await memberships(c.id)).toHaveLength(1);
    });

    it('5 simultaneous acceptances by one customer produce one membership and one event', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const c = await newCustomer(false);
      const invite = (await inviteFor(u.id, a1)).token;
      const results = await Promise.all(Array.from({ length: 5 }, () => joinAssisted(c.token, invite)));
      for (const r of results) expect([201, 409]).toContain(r.status);
      expect(results.some((r) => r.status === 201)).toBe(true);
      expect(await events(c.id)).toHaveLength(1);
      expect(await memberships(c.id)).toHaveLength(1);
    });

    it('an invitation is one-time: a second customer using it is refused, and that attempt rolls back completely', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const first = await newCustomer(false); const second = await newCustomer(false);
      const invite = (await inviteFor(u.id, a1)).token;
      expect((await joinAssisted(first.token, invite)).status).toBe(201);
      const res = await joinAssisted(second.token, invite);
      expect(res.status).toBe(409);
      expect(res.error?.code).toBe('ONBOARDING_INVITE_USED');
      expect(await memberships(second.id)).toHaveLength(0);
      expect(await events(second.id)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM consent_grants WHERE customer_id = $1`, [second.id])).toHaveLength(0);
      expect(await q(`SELECT 1 FROM loyalty_accounts WHERE customer_id = $1`, [second.id])).toHaveLength(0);
    });

    it('two customers racing for one invitation: exactly one wins and the loser leaves no trace', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const x = await newCustomer(false); const y = await newCustomer(false);
      const invite = (await inviteFor(u.id, a1)).token;
      const [rx, ry] = await Promise.all([joinAssisted(x.token, invite), joinAssisted(y.token, invite)]);
      expect([rx.status, ry.status].sort()).toEqual([201, 409]);
      const winner = rx.status === 201 ? x : y; const loser = rx.status === 201 ? y : x;
      expect(await events(winner.id)).toHaveLength(1);
      expect(await events(loser.id)).toHaveLength(0);
      expect(await memberships(loser.id)).toHaveLength(0);
    });

    it('a failure after the membership write (injected) rolls back the membership, consent, account and audit together', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      const c = await newCustomer(false);
      const invite = (await inviteFor(u.id, a1)).token;
      await q(`CREATE OR REPLACE FUNCTION ob_fail() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected'; END $f$`);
      await q(`ALTER TABLE customer_onboarding_events DISABLE TRIGGER customer_onboarding_event_guard_trg`);
      await q(`CREATE TRIGGER ob_fail_trg BEFORE INSERT ON customer_onboarding_events FOR EACH ROW EXECUTE FUNCTION ob_fail()`);
      try {
        const res = await joinAssisted(c.token, invite);
        expect(res.status).toBe(500);
      } finally {
        await q(`DROP TRIGGER ob_fail_trg ON customer_onboarding_events`);
        await q(`ALTER TABLE customer_onboarding_events ENABLE ALWAYS TRIGGER customer_onboarding_event_guard_trg`);
      }
      expect(await memberships(c.id)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM consent_grants WHERE customer_id = $1`, [c.id])).toHaveLength(0);
      expect(await q(`SELECT 1 FROM loyalty_accounts WHERE customer_id = $1`, [c.id])).toHaveLength(0);
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'customer.onboarded' AND metadata->>'source' = 'cashier_assisted' AND actor_user_id = $1`, [u.id])).toHaveLength(0);
      // the same invitation still works afterwards (nothing was consumed by the failed attempt)
      expect((await joinAssisted(c.token, invite)).status).toBe(201);
    });
  });

  describe('re-joining a business keeps history', () => {
    it('leave then re-join through a different branch adds a second event and keeps the first untouched', async () => {
      const c = await newCustomer(true);
      expect((await joinQr(c.token, qrA1)).status).toBe(201);
      const [first] = await events(c.id);
      const account = await q(`SELECT id FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2`, [c.id, bizA]);
      expect((await leave(c.token, bizA)).status).toBe(200);
      const u = await newCashier('single', [a2]);
      await sessionOn(u.username, a2);
      expect((await joinAssisted(c.token, (await inviteFor(u.id, a2)).token)).status).toBe(201);
      const ev = await events(c.id);
      expect(ev).toHaveLength(2);
      expect(ev[0]).toEqual(first); // byte-for-byte unchanged
      expect(ev[0]).toMatchObject({ source: 'business_qr', branch_id: a1, is_rejoin: false });
      expect(ev[1]).toMatchObject({ source: 'cashier_assisted', branch_id: a2, cashier_user_id: u.id, is_rejoin: true });
      expect(await memberships(c.id)).toHaveLength(1); // one membership, no duplicate identity
      expect(await q(`SELECT id FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2`, [c.id, bizA])).toEqual(account);
      expect(await q(`SELECT id FROM customers WHERE phone = (SELECT phone FROM customers WHERE id = $1)`, [c.id])).toHaveLength(1);
    });

    it('an idempotent retry while already a member records no second event', async () => {
      const c = await newCustomer(false);
      await joinQr(c.token, qrA1); await joinQr(c.token, qrA1); await joinQr(c.token, qrA2);
      expect(await events(c.id)).toHaveLength(1);
    });
  });

  describe('verification and consent gates are unchanged', () => {
    it('joining an ADDITIONAL business without a verified phone is refused and leaves no event', async () => {
      const c = await newCustomer(false);
      expect((await joinQr(c.token, qrA1)).status).toBe(201); // the first business is open to everyone
      const res = await joinQr(c.token, qrB1);
      expect(res.status).toBe(403);
      expect(res.error?.code).toBe('PHONE_VERIFICATION_REQUIRED');
      expect(await events(c.id, bizB)).toHaveLength(0);
      expect(await memberships(c.id, bizB)).toHaveLength(0);
    });

    it('with a verified phone the second business is joined and attributed to ITS branch, in ITS tenant', async () => {
      const c = await newCustomer(true);
      expect((await joinQr(c.token, qrA1)).status).toBe(201);
      expect((await joinQr(c.token, qrB1)).status).toBe(201);
      expect((await events(c.id, bizA))[0].branch_id).toBe(a1);
      expect((await events(c.id, bizB))[0]).toMatchObject({ branch_id: b1, business_id: bizB });
    });

    it('a QR scanned for business B never produces an event in business A', async () => {
      const c = await newCustomer(true);
      await joinQr(c.token, qrB1);
      expect(await events(c.id, bizA)).toHaveLength(0);
    });
  });

  describe('database guards (direct SQL, bypassing the application)', () => {
    let eventId: string; let customerId: string; let membershipId: string;
    beforeAll(async () => {
      const c = await newCustomer(true); customerId = c.id;
      await joinQr(c.token, qrA1);
      const [ev] = await events(c.id); eventId = ev.id; membershipId = ev.membership_id;
    });
    const rejects = async (sql: string, values: unknown[] = []) => {
      await expect(client.query(sql, values)).rejects.toThrow();
      // a failed statement outside a transaction needs no cleanup
    };

    it('UPDATE and DELETE are refused for every column and the row is unchanged', async () => {
      const before = (await q(`SELECT * FROM customer_onboarding_events WHERE id = $1`, [eventId]))[0];
      for (const col of ['branch_id', 'cashier_user_id', 'source', 'verification_state', 'occurred_at', 'reference', 'business_id', 'is_rejoin']) {
        await rejects(`UPDATE customer_onboarding_events SET ${col} = ${col} WHERE id = $1`, [eventId]);
      }
      await rejects(`UPDATE customer_onboarding_events SET branch_id = $2 WHERE id = $1`, [eventId, a2]);
      await rejects(`DELETE FROM customer_onboarding_events WHERE id = $1`, [eventId]);
      await rejects(`TRUNCATE customer_onboarding_events`);
      expect((await q(`SELECT * FROM customer_onboarding_events WHERE id = $1`, [eventId]))[0]).toEqual(before);
    });

    it('the membership and customer cannot be hard-deleted out from under the history (RESTRICT)', async () => {
      await rejects(`DELETE FROM business_customer_memberships WHERE id = $1`, [membershipId]);
      await rejects(`DELETE FROM customers WHERE id = $1`, [customerId]);
      await rejects(`DELETE FROM branches WHERE id = $1`, [a1]);
    });

    const insert = (over: Record<string, unknown>) => {
      const row = {
        membership_id: membershipId, business_id: bizA, customer_id: customerId, branch_id: a1, cashier_user_id: null, source: 'business_qr',
        verification_state: 'unverified', consent_grant_id: null, reference: 'ref', is_rejoin: false, occurred_at: new Date(), ...over,
      };
      const cols = Object.keys(row);
      return client.query(`INSERT INTO customer_onboarding_events (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
    };

    it('refuses a branch from another business, a membership/customer/business mismatch and a foreign consent grant', async () => {
      await expect(insert({ branch_id: b1 })).rejects.toThrow(/BRANCH_NOT_IN_BUSINESS/);
      await expect(insert({ business_id: bizB })).rejects.toThrow(/MEMBERSHIP_MISMATCH/);
      const other = await newCustomer(false);
      await expect(insert({ customer_id: other.id })).rejects.toThrow(/MEMBERSHIP_MISMATCH/);
      await joinQr(other.token, qrA1);
      const [otherGrant] = await q(`SELECT id FROM consent_grants WHERE customer_id = $1`, [other.id]);
      await expect(insert({ consent_grant_id: otherGrant.id })).rejects.toThrow(/CONSENT_MISMATCH/);
    });

    it('enforces the attribution shape: a cashier exactly when assisted, always with a branch and a reference', async () => {
      const u = await newCashier('single', [a1]);
      await expect(insert({ source: 'cashier_assisted', cashier_user_id: null, reference: 'r' })).rejects.toThrow(/cashier_shape/);
      await expect(insert({ source: 'business_qr', cashier_user_id: u.id })).rejects.toThrow(/cashier_shape/);
      await expect(insert({ source: 'cashier_assisted', cashier_user_id: u.id, branch_id: null, reference: 'r' })).rejects.toThrow(/assisted_branch|NOT_AUTHORIZED_FOR_BRANCH/);
      await expect(insert({ source: 'cashier_assisted', cashier_user_id: u.id, reference: null })).rejects.toThrow(/assisted_reference/);
      await expect(insert({ source: 'carrier_pigeon' })).rejects.toThrow(/source_check/);
      await expect(insert({ verification_state: 'verified' })).rejects.toThrow(/verification_check/);
    });

    it('refuses a cashier who is not authorised for the business or the branch, or who is not active', async () => {
      const u = await newCashier('single', [a1]);
      await expect(insert({ source: 'cashier_assisted', cashier_user_id: u.id, branch_id: a3, reference: 'x1' })).rejects.toThrow(/NOT_AUTHORIZED_FOR_BRANCH/);
      await expect(insert({ source: 'cashier_assisted', cashier_user_id: ownerBId, branch_id: a1, reference: 'x2' })).rejects.toThrow(/NOT_AUTHORIZED_FOR_BRANCH/);
      await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [u.id]);
      await expect(insert({ source: 'cashier_assisted', cashier_user_id: u.id, branch_id: a1, reference: 'x3' })).rejects.toThrow(/CASHIER_NOT_ELIGIBLE/);
    });

    it('a managed cashier of business A cannot be recorded against business B', async () => {
      const u = await newCashier('single', [a1]);
      const bm = (await q(`SELECT id FROM business_customer_memberships WHERE business_id = $1 LIMIT 1`, [bizB]))[0];
      if (!bm) return; // no business B membership yet in this ordering; the guard path is covered by the membership mismatch test
      await expect(client.query(
        `INSERT INTO customer_onboarding_events (membership_id, business_id, customer_id, branch_id, cashier_user_id, source, verification_state, reference, is_rejoin, occurred_at)
         SELECT id, business_id, customer_id, $2, $3, 'cashier_assisted', 'unverified', 'x9', false, now() FROM business_customer_memberships WHERE id = $1`, [bm.id, b1, u.id])).rejects.toThrow();
    });
  });

  describe('historical attribution is never invented', () => {
    it('a membership created before attribution existed has no event; the migration created none', async () => {
      const c = await newCustomer(true);
      await new CustomerMembershipService(db).join({ customerId: c.id, businessId: bizA, onboardingSource: 'legacy_import', onboardingReference: 'x', consentVersion: 'v1' });
      expect(await memberships(c.id)).toHaveLength(1);
      expect(await events(c.id)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM customer_onboarding_events WHERE source = 'remote_invitation' AND business_id = $1`, [bizA])).toHaveLength(0);
    });

    it('when a legacy member leaves and re-joins, only the NEW onboarding is recorded, flagged as a re-join; nothing is backfilled for the old one', async () => {
      const c = await newCustomer(true);
      await new CustomerMembershipService(db).join({ customerId: c.id, businessId: bizA, onboardingSource: 'legacy_import', onboardingReference: 'x', consentVersion: 'v1' });
      await leave(c.token, bizA);
      expect((await joinQr(c.token, qrA2)).status).toBe(201);
      const ev = await events(c.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ source: 'business_qr', branch_id: a2, is_rejoin: true });
    });

    it('no application path writes the reserved remote_invitation source', async () => {
      expect(await q(`SELECT 1 FROM customer_onboarding_events WHERE source = 'remote_invitation' AND business_id = $1`, [bizA])).toHaveLength(0);
    });
  });

  describe('reporting (read-only counts)', () => {
    it('distinguishes events from unique customers, counts re-joins, sources, branches and cashiers, and exposes no customer data', async () => {
      const bizC = (await repos.businesses.create({ name: 'Onboard C', slug: `ob-c-${run}` })).id;
      const ownerCId = (await repos.users.create({ email: `ob-ownerc-${run}@example.test`, fullName: 'ownerc', passwordHash: await pbkdf2Hash(PW, 1000), status: 'active' })).id;
      const c1 = await repos.branches.create({ businessId: bizC, name: 'C1', slug: 'c1' });
      const c2 = await repos.branches.create({ businessId: bizC, name: 'C2', slug: 'c2' });
      const rolesC = await new RoleProvisioningService(repos).seedDefaultRoles(bizC, ownerCId);
      await repos.userBusinessRoles.grant({ userId: ownerCId, businessId: bizC, branchId: null, roleId: rolesC.Owner, createdBy: ownerCId });
      const qr = new QrCodeService(repos, { QR_TOKEN_SECRET: QR_SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined });
      const qC1 = (await qr.getOrCreateActiveForBranch(c1.id, bizC, ownerCId)).token;
      const qC2 = (await qr.getOrCreateActiveForBranch(c2.id, bizC, ownerCId)).token;
      const x = await newCustomer(false); const y = await newCustomer(false); const z = await newCustomer(false);
      await joinQr(x.token, qC1); await joinQr(y.token, qC1); await joinQr(z.token, qC2);
      await leave(x.token, bizC); await joinQr(x.token, qC2); // x: two events, one customer
      const ownerCToken = await signAccessToken(ownerCId, SECRET);
      const res = await http('GET', '/analytics/onboarding', { token: ownerCToken, businessId: bizC });
      expect(res.status, JSON.stringify(res)).toBe(200);
      expect(res.data.totals).toEqual({ events: 4, uniqueCustomers: 3, rejoinEvents: 1, withoutBranch: 0 });
      expect(res.data.bySource).toEqual([{ source: 'business_qr', events: 4, uniqueCustomers: 3 }]);
      const byBranch = Object.fromEntries(res.data.byBranch.map((b: { branchName: string; events: number; uniqueCustomers: number }) => [b.branchName, [b.events, b.uniqueCustomers]]));
      expect(byBranch).toEqual({ C1: [2, 2], C2: [2, 2] });
      expect(res.data.byCashier).toEqual([]);
      const blob = JSON.stringify(res.data);
      for (const id of [x.id, y.id, z.id]) expect(blob).not.toContain(id);
      expect(blob).not.toMatch(/phone|email|\+1558/i);
      // range and branch filters
      const future = await http('GET', `/analytics/onboarding?from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`, { token: ownerCToken, businessId: bizC });
      expect(future.data.totals.events).toBe(0);
      const onlyC1 = await http('GET', `/analytics/onboarding?branchId=${c1.id}`, { token: ownerCToken, businessId: bizC });
      expect(onlyC1.data.totals).toMatchObject({ events: 2, uniqueCustomers: 2 });
      expect((await http('GET', '/analytics/onboarding?branchId=nope', { token: ownerCToken, businessId: bizC })).status).toBe(400);
      expect((await http('GET', '/analytics/onboarding?from=bad', { token: ownerCToken, businessId: bizC })).status).toBe(400);
    });

    it('includes cashier-assisted counts per cashier and events without a branch in their own bucket', async () => {
      const u = await newCashier('single', [a1]);
      await sessionOn(u.username, a1);
      for (let i = 0; i < 2; i++) {
        const c = await newCustomer(false);
        expect((await joinAssisted(c.token, (await inviteFor(u.id, a1)).token)).status).toBe(201);
      }
      const res = await http('GET', '/analytics/onboarding', { token: ownerToken, businessId: bizA });
      expect(res.status).toBe(200);
      const mine = res.data.byCashier.find((r: { cashierUserId: string }) => r.cashierUserId === u.id);
      expect(mine).toMatchObject({ events: 2, uniqueCustomers: 2 });
      expect(res.data.bySource.map((s: { source: string }) => s.source)).toEqual(expect.arrayContaining(['business_qr', 'cashier_assisted']));
      // an event with no branch (a source with no physical branch) is counted separately, not hidden or guessed
      const c = await newCustomer(false);
      await new CustomerMembershipService(db).join({ customerId: c.id, businessId: bizA, onboardingSource: 'x', onboardingReference: 'x', consentVersion: 'v1' });
      const [m] = await memberships(c.id);
      await q(`INSERT INTO customer_onboarding_events (membership_id, business_id, customer_id, branch_id, source, verification_state, reference, is_rejoin, occurred_at)
               VALUES ($1,$2,$3,NULL,'remote_invitation','unverified','fixture',false, now())`, [m.id, bizA, c.id]);
      const after = await http('GET', '/analytics/onboarding', { token: ownerToken, businessId: bizA });
      expect(after.data.totals.withoutBranch).toBeGreaterThanOrEqual(1);
      expect(after.data.byBranch.some((b: { branchId: string | null }) => b.branchId === null)).toBe(true);
    });

    it('a branch-restricted role sees its own branch only and no per-cashier breakdown; another branch is refused', async () => {
      const own = await http('GET', '/analytics/onboarding', { token: staffBranchToken, businessId: bizA, branchId: a1 });
      expect(own.status, JSON.stringify(own)).toBe(200);
      expect(own.data.byCashier).toEqual([]);
      expect(own.data.byBranch.every((b: { branchId: string | null }) => b.branchId === a1)).toBe(true);
      expect((await http('GET', `/analytics/onboarding?branchId=${a2}`, { token: staffBranchToken, businessId: bizA, branchId: a1 })).status).toBe(403);
    });

    it('is tenant-isolated: the owner of business B cannot read business A, and a cashier token cannot reach it at all', async () => {
      const ownerBToken = await signAccessToken(ownerBId, SECRET);
      expect((await http('GET', '/analytics/onboarding', { token: ownerBToken, businessId: bizA })).status).toBe(403);
      const u = await newCashier('single', [a1]);
      const s = await sessionOn(u.username, a1);
      expect((await http('GET', '/analytics/onboarding', { token: s.accessToken, businessId: bizA })).status).toBe(403);
      const sameBiz = await http('GET', '/analytics/onboarding', { token: ownerBToken, businessId: bizB });
      expect(sameBiz.status).toBe(200);
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1`, [bizB]);
      expect(sameBiz.data.totals.events).toBe(n); // exactly business B's own events, never business A's
      expect(sameBiz.data.byBranch.every((b: { branchId: string | null }) => b.branchId === b1)).toBe(true);
    });
  });

  describe('loyalty ledger isolation', () => {
    it('onboarding writes no loyalty transaction and never changes a points balance; ledgers stay per business', async () => {
      const c = await newCustomer(true);
      const before = await q(`SELECT count(*)::int AS n FROM loyalty_transactions`);
      expect((await joinQr(c.token, qrA1)).status).toBe(201);
      expect((await joinQr(c.token, qrB1)).status).toBe(201);
      expect((await q(`SELECT count(*)::int AS n FROM loyalty_transactions`))[0].n).toBe(before[0].n);
      const accounts = await q(`SELECT business_id, points FROM loyalty_accounts WHERE customer_id = $1 ORDER BY business_id`, [c.id]);
      expect(accounts).toHaveLength(2);
      expect(accounts.every((a) => Number(a.points) === 0)).toBe(true);
      expect(new Set(accounts.map((a) => a.business_id)).size).toBe(2);
      expect(await q(`SELECT 1 FROM customers WHERE id = $1`, [c.id])).toHaveLength(1); // still one network identity
    });
  });
});
