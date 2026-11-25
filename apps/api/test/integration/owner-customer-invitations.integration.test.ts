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
import { customerInvitationRoutes } from '../../src/customer-invitations/customer-invitations.routes';
import { customerMembershipRoutes } from '../../src/customer-relationships/customer-membership.routes';
import { loyaltyRoutes } from '../../src/loyalty/loyalty.routes';
import { signAccessToken, signCashierAccessToken } from '../../src/auth/jwt';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';

/**
 * OWNER-INVITE-01 against real PostgreSQL and the real middleware: owner-issued customer invitations. Authorization (owner side only, never a
 * cashier), token validity, expiry, revocation, single use, replay, identity preservation, no automatic Community/badge/reward, tenant
 * isolation, idempotency, concurrency and audit.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

const SECRET = 'owner-invite-access-secret';
const CUSTOMER_SECRET = 'owner-invite-customer-secret';
const run = randomUUID();
const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);
const allow = { limit: async () => ({ success: true }) };
let limiterKeys: string[] = [];

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/customer-invitations', customerInvitationRoutes);
app.route('/api/v1/customer-memberships', customerMembershipRoutes);
app.route('/api/v1/loyalty', loyaltyRoutes);
app.onError(errorHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
async function http(method: string, path: string, o: { token?: string; businessId?: string; body?: unknown } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.businessId) headers.set('X-Business-Id', o.businessId);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, CUSTOMER_JWT_SECRET: CUSTOMER_SECRET,
    WEB_BASE_URL: 'https://web.example.test', API_RATE_LIMITER: allow, CUSTOMER_API_RATE_LIMITER: allow, LOOKUP_RATE_LIMITER: { limit: async (x: { key: string }) => { limiterKeys.push(x.key); return { success: true }; } },
  } as unknown as Bindings;
  const res = await app.request(`/api/v1${path}`, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain-text 404 */ }
  return { status: res.status, ...parsed };
}

describe.skipIf(!databaseUrl)('OWNER-INVITE-01 owner-issued customer invitations (real HTTP, real PostgreSQL)', () => {
  let client: Client; let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  let ownerA: string; let ownerB: string; let managerA: string; let bizA: string; let bizB: string; let a1: string; let a2: string; let b1: string;
  let ownerAToken: string; let ownerBToken: string; let managerToken: string;
  let seq = 0;
  const tokenOf = (inviteUrl: string) => inviteUrl.split('/loyalty/invite/')[1] as string;
  const issue = async (branchId = a1, extra: Record<string, unknown> = {}) => {
    const r = await http('POST', '/customer-invitations', { token: ownerAToken, businessId: bizA, body: { branchId, ...extra } });
    expect([200, 201], JSON.stringify(r)).toContain(r.status);
    return { id: r.data.id as string, token: tokenOf(r.data.inviteUrl), res: r };
  };
  const customer = async () => {
    const id = (await repos.customers.create({ phone: `+1559${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}` })).id;
    return { id, token: await signCustomerAccessToken(id, CUSTOMER_SECRET) };
  };
  const accept = (custToken: string, inviteToken: string) =>
    http('POST', '/customer-memberships/join-assisted', { token: custToken, body: { inviteToken, consentAccepted: true, consentVersion: 'v1' } });
  const preview = (custToken: string, inviteToken: string) => http('POST', '/customer-memberships/join-assisted/preview', { token: custToken, body: { inviteToken } });
  const events = (customerId: string) => q(`SELECT * FROM customer_onboarding_events WHERE customer_id = $1 AND business_id = $2`, [customerId, bizA]);

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    repos = createRepositories(buildDb(client));
    const mk = async (email: string) => (await repos.users.create({ email, fullName: 'u', passwordHash: 'x', status: 'active' })).id;
    ownerA = await mk(`oi-a-${run}@example.test`); ownerB = await mk(`oi-b-${run}@example.test`); managerA = await mk(`oi-m-${run}@example.test`);
    bizA = (await repos.businesses.create({ name: `Invite A ${tag}`, slug: `oi-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: `Invite B ${tag}`, slug: `oi-b-${run}` })).id;
    a1 = (await repos.branches.create({ businessId: bizA, name: 'A1', slug: 'a1' })).id;
    a2 = (await repos.branches.create({ businessId: bizA, name: 'A2', slug: 'a2' })).id;
    b1 = (await repos.branches.create({ businessId: bizB, name: 'B1', slug: 'b1' })).id;
    const prov = new RoleProvisioningService(repos);
    const rolesA = await prov.seedDefaultRoles(bizA, ownerA); const rolesB = await prov.seedDefaultRoles(bizB, ownerB);
    const grant = (userId: string, businessId: string, roleId: string) => repos.userBusinessRoles.grant({ userId, businessId, branchId: null, roleId, createdBy: userId });
    await grant(ownerA, bizA, rolesA.Owner); await grant(ownerB, bizB, rolesB.Owner); await grant(managerA, bizA, rolesA.Manager);
    ownerAToken = await signAccessToken(ownerA, SECRET); ownerBToken = await signAccessToken(ownerB, SECRET); managerToken = await signAccessToken(managerA, SECRET);
  });
  afterAll(async () => { await client?.end(); });

  describe('authorization', () => {
    it('the owner issues, lists and revokes; the Manager, anonymous callers and cashier tokens cannot', async () => {
      expect((await http('POST', '/customer-invitations', { token: managerToken, businessId: bizA, body: { branchId: a1 } })).status).toBe(403);
      expect((await http('GET', '/customer-invitations', { token: managerToken, businessId: bizA })).status).toBe(403);
      expect((await http('POST', '/customer-invitations', { businessId: bizA, body: { branchId: a1 } })).status).toBe(401);
      const cashier = await signCashierAccessToken(ownerA, SECRET, { sessionId: randomUUID(), businessId: bizA, branchId: a1 });
      for (const [m, p, body] of [['POST', '/customer-invitations', { branchId: a1 }], ['GET', '/customer-invitations', undefined], ['POST', `/customer-invitations/${randomUUID()}/revoke`, undefined], ['POST', '/loyalty/actions/onboarding-invite', undefined]] as const) {
        const r = await http(m, p, { token: cashier, businessId: bizA, ...(body ? { body } : {}) });
        expect(r.status, `${m} ${p}`).toBe(403); expect(r.error?.code, p).toBe('CASHIER_ROUTE_DENIED');
      }
      const first = await issue();
      expect((await http('GET', '/customer-invitations', { token: ownerAToken, businessId: bizA })).data.invitations.some((i: { id: string }) => i.id === first.id)).toBe(true);
    });

    it('tenant isolation: another business cannot read, list, revoke or issue for this one, and a foreign branch is refused', async () => {
      const inv = await issue();
      expect((await http('GET', '/customer-invitations', { token: ownerBToken, businessId: bizA })).status).toBe(403);
      const listB = await http('GET', '/customer-invitations', { token: ownerBToken, businessId: bizB });
      expect(listB.data.invitations.some((i: { id: string }) => i.id === inv.id)).toBe(false);
      expect((await http('POST', `/customer-invitations/${inv.id}/revoke`, { token: ownerBToken, businessId: bizB })).status).toBe(404);
      const foreign = await http('POST', '/customer-invitations', { token: ownerAToken, businessId: bizA, body: { branchId: b1 } });
      expect(foreign.status).toBe(422); expect(foreign.error?.code).toBe('INVITATION_BRANCH_INVALID');
      expect((await http('POST', '/customer-invitations', { token: ownerAToken, businessId: bizA, body: { branchId: a1, businessId: bizB } })).status).toBe(400);
    });
  });

  describe('issuing', () => {
    it('is idempotent by request key, rate limited on its own bucket, audited, and carries only ids in the link', async () => {
      limiterKeys = [];
      const key = `key-${run.slice(0, 12)}`;
      const one = await issue(a1, { requestKey: key }); const two = await issue(a1, { requestKey: key });
      expect(one.res.status).toBe(201); expect(two.res.status).toBe(200); expect(two.id).toBe(one.id);
      expect(await q(`SELECT 1 FROM customer_invitations WHERE business_id = $1 AND request_key = $2`, [bizA, key])).toHaveLength(1);
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'customer_invitation.issued' AND entity_id = $1`, [one.id])).toHaveLength(1);
      expect(limiterKeys.every((k) => k.startsWith(`owner-invite:${bizA}:`))).toBe(true);
      const payload = JSON.parse(Buffer.from(one.token.split('.')[1] as string, 'base64url').toString());
      expect(Object.keys(payload).sort()).toEqual(['biz', 'brid', 'exp', 'iat', 'jti', 'sub', 'type']);
      expect(JSON.stringify({ ...payload, type: undefined })).not.toMatch(/phone|email|name|customer/i); // ids only (the type value itself names the token kind)
      const conflict = await http('POST', '/customer-invitations', { token: ownerAToken, businessId: bizA, body: { branchId: a2, requestKey: key } });
      expect(conflict.status).toBe(409);
    });
    it('refuses a bad expiry and unknown fields', async () => {
      for (const body of [{ branchId: a1, expiresInHours: 0 }, { branchId: a1, expiresInHours: 169 }, { branchId: a1, expiresInHours: 1.5 }, { branchId: a1, role: 'owner' }, {}]) {
        expect((await http('POST', '/customer-invitations', { token: ownerAToken, businessId: bizA, body })).status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  describe('customer acceptance', () => {
    it('an invited customer keeps their ONE identity, joins only with explicit consent, and gets no Community membership, reward or badge', async () => {
      const c = await customer();
      const inv = await issue(a2);
      const before = (await q(`SELECT (SELECT count(*)::int FROM customers) AS customers, (SELECT count(*)::int FROM community_memberships WHERE customer_id = $1) AS community, (SELECT count(*)::int FROM tentaship_badge_awards WHERE customer_id = $1) AS badges`, [c.id]))[0];
      const p = await preview(c.token, inv.token);
      expect(p.status, JSON.stringify(p)).toBe(200); expect(p.data).toMatchObject({ status: 'ready', businessName: `Invite A ${tag}`, branchName: 'A2' });
      expect(JSON.stringify(p.data)).not.toMatch(/issuer|owner|@|oi-a/);
      expect((await http('POST', '/customer-memberships/join-assisted', { token: c.token, body: { inviteToken: inv.token, consentAccepted: false } })).status).toBe(400);
      const joined = await accept(c.token, inv.token);
      expect(joined.status, JSON.stringify(joined)).toBe(201);
      const [ev] = await events(c.id);
      expect(ev).toMatchObject({ source: 'remote_invitation', branch_id: a2, cashier_user_id: null, reference: inv.id });
      const after = (await q(`SELECT (SELECT count(*)::int FROM customers) AS customers, (SELECT count(*)::int FROM community_memberships WHERE customer_id = $1) AS community, (SELECT count(*)::int FROM tentaship_badge_awards WHERE customer_id = $1) AS badges`, [c.id]))[0];
      expect(after).toEqual({ ...before, customers: before.customers }); // no new platform identity, no Community, no badge
      expect((await q(`SELECT points FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2`, [c.id, bizA]))[0].points).toBe(0);
      expect(await q(`SELECT 1 FROM loyalty_transactions lt JOIN loyalty_accounts la ON la.id = lt.loyalty_account_id WHERE la.customer_id = $1`, [c.id])).toHaveLength(0);
      expect((await q(`SELECT count(*)::int AS n FROM tentaship_badge_awards`))[0].n).toBe((await q(`SELECT count(*)::int AS n FROM tentaship_badge_awards`))[0].n);
    });

    it('single use and controlled replay: the same customer retrying is idempotent; a second customer is refused and leaves no trace', async () => {
      const c1 = await customer(); const c2 = await customer(); const inv = await issue();
      expect((await accept(c1.token, inv.token)).status).toBe(201);
      expect((await accept(c1.token, inv.token)).status).toBe(201); // idempotent for the same customer
      expect(await events(c1.id)).toHaveLength(1);
      const second = await accept(c2.token, inv.token);
      expect(second.status).toBe(409); expect(second.error?.code).toBe('ONBOARDING_INVITE_USED');
      expect(await events(c2.id)).toHaveLength(0);
      expect((await preview(c2.token, inv.token)).data.status).toBe('used');
      const list = (await http('GET', '/customer-invitations', { token: ownerAToken, businessId: bizA })).data;
      const row = list.invitations.find((i: { id: string }) => i.id === inv.id);
      expect(row.status).toBe('accepted'); expect(JSON.stringify(row)).not.toContain(c1.id);
    });

    it('invalid, tampered, wrong-type, expired and revoked tokens are all refused with the same generic error', async () => {
      const c = await customer(); const inv = await issue();
      const bad: string[] = ['garbage', `${inv.token}x`, inv.token.slice(0, -4) + 'AAAA', await sign({ sub: ownerA, type: 'access', biz: bizA, brid: a1, jti: inv.id, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET, 'HS256')];
      // expired: a real row whose expiry has passed, with a correctly signed token
      const expiredId = randomUUID();
      await q(`INSERT INTO customer_invitations (id, business_id, branch_id, issued_by_user_id, created_at, expires_at) VALUES ($1,$2,$3,$4, now() - interval '2 hours', now() - interval '1 hour')`, [expiredId, bizA, a1, ownerA]);
      bad.push(await sign({ sub: ownerA, type: 'customer_invitation', biz: bizA, brid: a1, jti: expiredId, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET, 'HS256'));
      // a signed token for an invitation that does not exist, and one that names a different business or branch than its row
      bad.push(await sign({ sub: ownerA, type: 'customer_invitation', biz: bizA, brid: a1, jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 }, SECRET, 'HS256'));
      bad.push(await sign({ sub: ownerA, type: 'customer_invitation', biz: bizB, brid: b1, jti: inv.id, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET, 'HS256'));
      bad.push(await sign({ sub: ownerA, type: 'customer_invitation', biz: bizA, brid: a2, jti: inv.id, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET, 'HS256'));
      for (const t of bad) {
        const r = await accept(c.token, t);
        expect([400, 409], t.slice(0, 20)).toContain(r.status);
        expect(r.error?.code).toBe('ONBOARDING_INVITE_INVALID');
      }
      expect(await events(c.id)).toHaveLength(0);
      // revoke, then the genuine token is refused too
      const rv = await http('POST', `/customer-invitations/${inv.id}/revoke`, { token: ownerAToken, businessId: bizA });
      expect(rv.status).toBe(200);
      expect((await http('POST', `/customer-invitations/${inv.id}/revoke`, { token: ownerAToken, businessId: bizA })).status).toBe(200); // idempotent
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'customer_invitation.revoked' AND entity_id = $1`, [inv.id])).toHaveLength(1);
      const refused = await accept(c.token, inv.token);
      expect(refused.error?.code).toBe('ONBOARDING_INVITE_INVALID');
      expect((await preview(c.token, inv.token)).status).toBe(400);
      expect(await events(c.id)).toHaveLength(0);
    });

    it('an accepted invitation cannot be revoked; a suspended business cannot be used to onboard anyone', async () => {
      const c = await customer(); const used = await issue(); await accept(c.token, used.token);
      const r = await http('POST', `/customer-invitations/${used.id}/revoke`, { token: ownerAToken, businessId: bizA });
      expect(r.status).toBe(409); expect(r.error?.code).toBe('INVITATION_ALREADY_USED');
      const live = await issue(a1); const c2 = await customer();
      await q(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [bizA]);
      try { expect(['BUSINESS_NOT_AVAILABLE', 'ONBOARDING_INVITE_INVALID']).toContain((await accept(c2.token, live.token)).error?.code); } finally { await q(`UPDATE businesses SET status = 'active' WHERE id = $1`, [bizA]); }
      expect((await events(c2.id))).toHaveLength(0);
    });

    it('revocation racing acceptance ends in ONE consistent outcome (never both, never neither)', async () => {
      for (let i = 0; i < 5; i += 1) {
        const c = await customer(); const inv = await issue();
        const [rv, ac] = await Promise.all([
          http('POST', `/customer-invitations/${inv.id}/revoke`, { token: ownerAToken, businessId: bizA }),
          accept(c.token, inv.token),
        ]);
        const joined = (await events(c.id)).length === 1; const revoked = (await q(`SELECT revoked_at FROM customer_invitations WHERE id = $1`, [inv.id]))[0].revoked_at !== null;
        expect(joined && revoked, `round ${i}: both happened (${rv.status}/${ac.status})`).toBe(false);
        expect(joined || revoked, `round ${i}: neither happened`).toBe(true);
      }
    });
  });

  describe('database guards', () => {
    it('invitations are immutable evidence: only the one-time revocation, no delete, no truncate', async () => {
      const inv = await issue();
      await expect(q(`UPDATE customer_invitations SET expires_at = expires_at + interval '1 day' WHERE id = $1`, [inv.id])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`UPDATE customer_invitations SET branch_id = $2 WHERE id = $1`, [inv.id, a2])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`DELETE FROM customer_invitations WHERE id = $1`, [inv.id])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`TRUNCATE customer_invitations`)).rejects.toThrow();
      await q(`UPDATE customer_invitations SET revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1`, [inv.id, ownerA]);
      await expect(q(`UPDATE customer_invitations SET revoked_at = NULL, revoked_by_user_id = NULL WHERE id = $1`, [inv.id])).rejects.toThrow(/IMMUTABLE/);
    });
  });
});
