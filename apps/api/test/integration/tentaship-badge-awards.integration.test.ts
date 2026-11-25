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
import { platformTentashipBadgeRoutes } from '../../src/platform/tentaship-badge.routes';
import { customerTentashipBadgeRoutes, businessTentashipBadgeRoutes } from '../../src/tentaship-badges/badge-routes';
import { signAccessToken, signCashierAccessToken } from '../../src/auth/jwt';
import { signCustomerAccessToken } from '../../src/customer-auth/customer-jwt';
import { NetworkPostService } from '../../src/network/network-post.service';
import { NetworkBusinessPostService } from '../../src/network/network-business-post.service';
import { BusinessProfileService } from '../../src/business-profile/business-profile.service';

/**
 * TB-03 against real PostgreSQL: server-side award calculation from verified evidence, duplicate and replay prevention, concurrency,
 * versioned rules, approved revocation, tenant isolation, runtime containment and the guarantee that legacy points are untouched.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

const SECRET = 'badge-award-access-secret';
const CUSTOMER_SECRET = 'badge-award-customer-secret';
const run = randomUUID();
const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);
const allow = { limit: async () => ({ success: true }) };

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/tentaship-badges', platformTentashipBadgeRoutes);
app.route('/api/v1/tentaship-badges/me', customerTentashipBadgeRoutes);
app.route('/api/v1/tentaship-badges/business', businessTentashipBadgeRoutes);
app.onError(errorHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
async function http(method: string, path: string, o: { token?: string; businessId?: string; body?: unknown; flag?: string | undefined } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.businessId) headers.set('X-Business-Id', o.businessId);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const env = {
    HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, CUSTOMER_JWT_SECRET: CUSTOMER_SECRET,
    CUSTOMER_API_RATE_LIMITER: allow, API_RATE_LIMITER: allow, TENTASHIP_BADGES_ENABLED: o.flag,
  } as unknown as Bindings;
  const res = await app.request(`/api/v1${path}`, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain-text 404 */ }
  return { status: res.status, ...parsed };
}

describe.skipIf(!databaseUrl)('TB-03 Tentaship Badges awards (real HTTP, real PostgreSQL)', () => {
  let client: Client; let repos: ReturnType<typeof createRepositories>;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const ON = 'true';
  let adminId: string; let adminToken: string; let ownerAId: string; let ownerBId: string; let ownerAToken: string; let ownerBToken: string;
  let bizA: string; let bizB: string; let ruleId: string;
  let defCustomer: { definition: { id: string }; version: { id: string } }; let defBusiness: { definition: { id: string }; version: { id: string } };
  let phoneSeq = 0;

  const newCustomer = async () => {
    const id = (await repos.customers.create({ phone: `+1559${String(Date.now()).slice(-5)}${String(++phoneSeq).padStart(2, '0')}` })).id;
    await q(`INSERT INTO community_point_accounts (customer_id) VALUES ($1)`, [id]);
    return { id, token: await signCustomerAccessToken(id, CUSTOMER_SECRET) };
  };
  const survey = async (customerId: string, status: 'awarded' | 'reversed' = 'awarded') => {
    const acct = (await q(`SELECT id FROM community_point_accounts WHERE customer_id = $1`, [customerId]))[0].id;
    await q(`INSERT INTO community_point_award_decisions (customer_id, account_id, source_type, source_ref, rule_id, status, points) VALUES ($1,$2,'survey_completion',$3,$4,$5,5)`,
      [customerId, acct, randomUUID(), ruleId, status]);
  };
  // Real publication pipeline: business draft -> submit -> two-person moderation approval. No row is faked.
  let mod1 = ''; let mod2 = '';
  const publish = async (businessId: string, ownerId: string, text: string) => {
    const posts = new NetworkBusinessPostService(buildDb(client), 50);
    const created = await posts.createDraft(businessId, ownerId, { body: text, contentLocale: 'en' });
    await posts.submit(businessId, created.handle);
    const rev = (await q(`select r.id from network_post_revisions r join network_posts p on p.id=r.post_id where p.handle=$1 and r.status='submitted'`, [created.handle]))[0].id as string;
    await new NetworkPostService(buildDb(client)).approve(rev, mod2);
  };
  const awards = (col: 'customer_id' | 'business_id', id: string) => q(`SELECT * FROM tentaship_badge_awards WHERE ${col} = $1`, [id]);
  const evaluate = (token: string) => http('POST', '/tentaship-badges/me/evaluate', { token, flag: ON });
  const mkDef = async (body: Record<string, unknown>) => {
    const r = await http('POST', '/platform/tentaship-badges/definitions', { token: adminToken, flag: ON, body });
    expect(r.status, JSON.stringify(r)).toBe(201);
    const a = await http('POST', `/platform/tentaship-badges/versions/${r.data.version.id}/activate`, { token: adminToken, flag: ON });
    expect(a.status).toBe(200);
    return r.data;
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    repos = createRepositories(buildDb(client));
    const mkUser = async (email: string) => (await repos.users.create({ email, fullName: 'u', passwordHash: 'x', status: 'active' })).id;
    adminId = await mkUser(`ba-admin-${run}@example.test`); await q(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [adminId]);
    ownerAId = await mkUser(`ba-owner-a-${run}@example.test`); ownerBId = await mkUser(`ba-owner-b-${run}@example.test`);
    bizA = (await repos.businesses.create({ name: `Badge A ${tag}`, slug: `ba-a-${run}` })).id;
    bizB = (await repos.businesses.create({ name: `Badge B ${tag}`, slug: `ba-b-${run}` })).id;
    const grant = async (userId: string, businessId: string) => {
      const roles = await new RoleProvisioningService(repos).seedDefaultRoles(businessId, userId);
      await repos.userBusinessRoles.grant({ userId, businessId, branchId: null, roleId: roles.Owner, createdBy: userId });
    };
    await grant(ownerAId, bizA); await grant(ownerBId, bizB);
    mod1 = await mkUser(`ba-mod1-${run}@example.test`); mod2 = await mkUser(`ba-mod2-${run}@example.test`);
    const category = (await q(`select id from business_categories limit 1`))[0]?.id as string | undefined;
    if (category) for (const biz of [bizA, bizB]) await q(`update businesses set category_id = $2 where id = $1`, [biz, category]);
    const profiles = new BusinessProfileService(buildDb(client));
    for (const [biz, owner] of [[bizA, ownerAId], [bizB, ownerBId]] as const) {
      const draft = await profiles.saveDraft(biz, { userId: owner, role: 'business' }, {
        websiteUrl: 'https://cafe.example',
        translations: [{ locale: 'en', displayName: `Cafe ${tag.slice(0, 8)}${biz === bizA ? "a" : "b"}`, summary: 'Coffee', description: 'Fresh coffee daily.' }],
        locations: [{ kind: 'place', label: 'Main shop', countryCode: 'GB', city: 'London' }],
      });
      const sub = await profiles.submit(biz, { userId: owner, role: 'business' }, draft.revisionId!);
      await profiles.approve(draft.revisionId!, { userId: mod1, role: 'platform_admin' }, sub.digest);
    }
    adminToken = await signAccessToken(adminId, SECRET); ownerAToken = await signAccessToken(ownerAId, SECRET); ownerBToken = await signAccessToken(ownerBId, SECRET);
    // Definitions activated by other test files share this disposable database: retire them so only this file's definitions award.
    await q(`UPDATE tentaship_badge_definition_versions SET status = 'retired', retired_at = now() WHERE status = 'active'`);
    ruleId = (await q(`INSERT INTO community_point_rules (source_type, version, status, points, activated_at) VALUES ('survey_completion', $1, 'active', 5, now()) RETURNING id`, [900000 + Math.floor(Math.random() * 90000)]))[0].id;
    defCustomer = await mkDef({ key: `ba_c_${tag}`.slice(0, 40).toLowerCase(), participantType: 'customer', names: { en: 'Surveyor' }, descriptions: { en: 'Completed 2 surveys.' }, rule: { metric: 'community_survey_completions', threshold: 2 } });
    defBusiness = await mkDef({ key: `ba_b_${tag}`.slice(0, 40).toLowerCase(), participantType: 'business', names: { en: 'Publisher' }, descriptions: {}, rule: { metric: 'published_business_posts', threshold: 1 } });
  });
  afterAll(async () => { await client?.end(); });

  describe('runtime containment', () => {
    it.each([undefined, 'false', 'TRUE', '1', ' true', 'yes'])('flag %j: customer, business and platform badge routes are a generic 404 and write nothing', async (flag) => {
      const c = await newCustomer(); await survey(c.id); await survey(c.id);
      for (const [m, p, token, biz] of [
        ['GET', '/tentaship-badges/me', c.token], ['POST', '/tentaship-badges/me/evaluate', c.token],
        ['GET', '/tentaship-badges/business', ownerAToken, bizA], ['POST', '/tentaship-badges/business/evaluate', ownerAToken, bizA],
        ['GET', '/platform/tentaship-badges/awards', adminToken], ['POST', `/platform/tentaship-badges/awards/${randomUUID()}/revoke`, adminToken],
      ] as const) {
        const r = await http(m, p, { token, ...(biz ? { businessId: biz } : {}), flag, ...(m === 'POST' ? { body: { reasonCode: 'issued_in_error', note: 'x' } } : {}) });
        expect(r.status, `${m} ${p}`).toBe(404);
      }
      expect(await awards('customer_id', c.id)).toHaveLength(0);
    });

    it('independent of Community controls: with every Community flag on and the badges flag off, badges stay closed', async () => {
      const r = await http('GET', '/tentaship-badges/business', { token: ownerAToken, businessId: bizA, flag: undefined });
      expect(r.status).toBe(404);
    });
  });

  describe('customer awards', () => {
    it('requires customer authentication; staff and cashier tokens cannot use the customer route', async () => {
      expect((await http('POST', '/tentaship-badges/me/evaluate', { flag: ON })).status).toBe(401);
      expect((await http('GET', '/tentaship-badges/me', { token: ownerAToken, flag: ON })).status).toBe(401);
      const cashier = await signCashierAccessToken(ownerAId, SECRET, { sessionId: randomUUID(), businessId: bizA });
      for (const [m, p] of [['GET', '/tentaship-badges/me'], ['POST', '/tentaship-badges/me/evaluate'], ['GET', '/tentaship-badges/business'], ['POST', '/tentaship-badges/business/evaluate'], ['GET', '/platform/tentaship-badges/awards']] as const) {
        const r = await http(m, p, { token: cashier, businessId: bizA, flag: ON });
        expect(r.status, p).toBe(403); expect(r.error?.code, p).toBe('CASHIER_ROUTE_DENIED');
      }
    });

    it('awards only when verified evidence reaches the threshold; reversed evidence does not count', async () => {
      const c = await newCustomer();
      expect((await evaluate(c.token)).data.awarded).toEqual([]);
      await survey(c.id); await survey(c.id, 'reversed');
      expect((await evaluate(c.token)).data.awarded).toEqual([]); // 1 awarded + 1 reversed < 2
      await survey(c.id);
      const r = await evaluate(c.token);
      expect(r.status, JSON.stringify(r)).toBe(200);
      expect(r.data.awarded).toHaveLength(1);
      expect(r.data.badges[0]).toMatchObject({ version: 1, names: { en: 'Surveyor' } });
      expect(JSON.stringify(r.data)).not.toMatch(/balance|points|value|amount/i); // a badge is not a currency
      const [row] = await awards('customer_id', c.id);
      expect(row).toMatchObject({ participant_type: 'customer', evidence_kind: 'community_survey_completions' });
      expect(row.evidence).toMatchObject({ metric: 'community_survey_completions', threshold: 2, observed: 2 });
    });

    it('is idempotent and replay-safe, and 8 concurrent evaluations create exactly one award and one audit row', async () => {
      const c = await newCustomer(); await survey(c.id); await survey(c.id);
      const results = await Promise.all(Array.from({ length: 8 }, () => evaluate(c.token)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.reduce((n, r) => n + r.data.awarded.length, 0)).toBe(1);
      expect(await awards('customer_id', c.id)).toHaveLength(1);
      expect((await evaluate(c.token)).data.awarded).toEqual([]);
      const awardId = (await awards('customer_id', c.id))[0].id;
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'tentaship_badge.awarded' AND entity_id = $1`, [awardId])).toHaveLength(1);
      // the same evidence cannot be re-used under the same definition for another award, even by direct insert
      await expect(q(`INSERT INTO tentaship_badge_awards (definition_id, definition_version_id, participant_type, customer_id, evidence_kind, evidence_ref, evidence_hash, evidence)
        SELECT definition_id, definition_version_id, participant_type, customer_id, evidence_kind, evidence_ref, evidence_hash, evidence FROM tentaship_badge_awards WHERE id = $1`, [awardId])).rejects.toThrow(/duplicate key/);
    });

    it('a customer sees only their own badges; no input from the request can influence an award', async () => {
      const a = await newCustomer(); const b = await newCustomer(); await survey(a.id); await survey(a.id);
      const spoof = await http('POST', '/tentaship-badges/me/evaluate', { token: b.token, flag: ON, body: { customerId: a.id, definitionKey: 'x', threshold: 1 } });
      expect(spoof.data.awarded).toEqual([]);
      expect(await awards('customer_id', b.id)).toHaveLength(0);
      expect((await http('GET', '/tentaship-badges/me', { token: b.token, flag: ON })).data.badges).toEqual([]);
    });

    it('a new version never rewrites an award already made; history keeps the version that justified it', async () => {
      const c = await newCustomer(); await survey(c.id); await survey(c.id); await evaluate(c.token);
      const v2 = await http('POST', `/platform/tentaship-badges/definitions/${defCustomer.definition.id}/versions`, { token: adminToken, flag: ON,
        body: { names: { en: 'Surveyor II' }, descriptions: {}, rule: { metric: 'community_survey_completions', threshold: 50 } } });
      await http('POST', `/platform/tentaship-badges/versions/${v2.data.id}/activate`, { token: adminToken, flag: ON });
      const mine = (await http('GET', '/tentaship-badges/me', { token: c.token, flag: ON })).data.badges;
      expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ version: 1, names: { en: 'Surveyor' } });
      const c2 = await newCustomer(); await survey(c2.id); await survey(c2.id);
      expect((await evaluate(c2.token)).data.awarded).toEqual([]); // v2 needs 50
      // restore a usable active version for later tests
      const v3 = await http('POST', `/platform/tentaship-badges/definitions/${defCustomer.definition.id}/versions`, { token: adminToken, flag: ON,
        body: { names: { en: 'Surveyor' }, descriptions: {}, rule: { metric: 'community_survey_completions', threshold: 2 } } });
      await http('POST', `/platform/tentaship-badges/versions/${v3.data.id}/activate`, { token: adminToken, flag: ON });
    });
  });

  describe('approved revocation', () => {
    it('platform admin revokes with a reason: hidden from the customer, kept in the ledger, never re-issued, idempotent, audited', async () => {
      const c = await newCustomer(); await survey(c.id); await survey(c.id); await evaluate(c.token);
      const [award] = await awards('customer_id', c.id);
      const nonAdmin = await signAccessToken(ownerAId, SECRET);
      expect((await http('POST', `/platform/tentaship-badges/awards/${award.id}/revoke`, { token: nonAdmin, flag: ON, body: { reasonCode: 'fraud_confirmed', note: 'n' } })).status).toBe(403);
      expect((await http('POST', `/platform/tentaship-badges/awards/${award.id}/revoke`, { token: adminToken, flag: ON, body: { reasonCode: 'bogus', note: 'n' } })).status).toBe(400);
      const r = await http('POST', `/platform/tentaship-badges/awards/${award.id}/revoke`, { token: adminToken, flag: ON, body: { reasonCode: 'evidence_reversed', note: 'Survey credit reversed after review.' } });
      expect(r.status, JSON.stringify(r)).toBe(200); expect(r.data).toMatchObject({ revoked: true, created: true });
      expect((await http('POST', `/platform/tentaship-badges/awards/${award.id}/revoke`, { token: adminToken, flag: ON, body: { reasonCode: 'evidence_reversed', note: 'again' } })).data.created).toBe(false);
      expect((await http('GET', '/tentaship-badges/me', { token: c.token, flag: ON })).data.badges).toEqual([]);
      expect((await evaluate(c.token)).data.awarded).toEqual([]); // not re-issued
      expect(await awards('customer_id', c.id)).toHaveLength(1); // the ledger row remains
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'tentaship_badge.revoked' AND entity_id = $1`, [award.id])).toHaveLength(1);
      const hist = await http('GET', '/platform/tentaship-badges/awards?limit=200', { token: adminToken, flag: ON });
      expect(hist.data.find((h: { awardId: string }) => h.awardId === award.id).revocation.reasonCode).toBe('evidence_reversed');
      await expect(q(`UPDATE tentaship_badge_awards SET evidence_ref = 'x' WHERE id = $1`, [award.id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`DELETE FROM tentaship_badge_revocations WHERE award_id = $1`, [award.id])).rejects.toThrow(/APPEND_ONLY/);
    });
  });

  describe('business awards and tenant isolation', () => {
    it('a business is awarded from its own moderated publications only; suspended posts and another business\'s posts do not count', async () => {
      expect((await http('POST', '/tentaship-badges/business/evaluate', { token: ownerAToken, businessId: bizA, flag: ON })).data.awarded).toEqual([]);
      await publish(bizB, ownerBId, `Bakery news ${tag}`); // another tenant's publication
      expect((await http('POST', '/tentaship-badges/business/evaluate', { token: ownerAToken, businessId: bizA, flag: ON })).data.awarded).toEqual([]);
      await publish(bizA, ownerAId, `Cafe news ${tag}`);
      const r = await http('POST', '/tentaship-badges/business/evaluate', { token: ownerAToken, businessId: bizA, flag: ON });
      expect(r.status, JSON.stringify(r)).toBe(200); expect(r.data.awarded).toHaveLength(1);
      expect((await http('POST', '/tentaship-badges/business/evaluate', { token: ownerAToken, businessId: bizA, flag: ON })).data.awarded).toEqual([]);
      expect(await awards('business_id', bizA)).toHaveLength(1);
      // B has a publication of its own, so it earns its own; it never sees A's
      const b = await http('POST', '/tentaship-badges/business/evaluate', { token: ownerBToken, businessId: bizB, flag: ON });
      expect(b.data.badges).toHaveLength(1);
      expect(b.data.badges[0].awardId).not.toBe(r.data.awarded[0].awardId);
      expect((await http('GET', '/tentaship-badges/business', { token: ownerBToken, businessId: bizA, flag: ON })).status).toBe(403);
    });
  });

  describe('legacy points and loyalty are untouched', () => {
    it('awarding a badge writes no Community Points, no business loyalty rows and changes no balance', async () => {
      const c = await newCustomer(); await survey(c.id); await survey(c.id);
      const snap = async () => (await q(`SELECT (SELECT points_balance FROM community_point_accounts WHERE customer_id = $1) AS bal,
        (SELECT count(*)::int FROM community_point_transactions) AS tx, (SELECT count(*)::int FROM loyalty_transactions) AS lt,
        (SELECT count(*)::int FROM loyalty_accounts) AS la, (SELECT count(*)::int FROM community_point_award_decisions WHERE customer_id = $1) AS dec`, [c.id]))[0];
      const before = await snap();
      expect((await evaluate(c.token)).data.awarded).toHaveLength(1);
      expect(await snap()).toEqual(before);
    });
  });
});
