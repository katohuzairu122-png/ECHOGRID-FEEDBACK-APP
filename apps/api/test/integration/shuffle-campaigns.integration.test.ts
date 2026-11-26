import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { platformShuffleRoutes } from '../../src/platform/shuffle.routes';
import { signAccessToken, signCashierAccessToken } from '../../src/auth/jwt';
import { hashSpec, parseQualificationSpec } from '../../src/qualification/qualification-spec';

/**
 * TSH-03 against real PostgreSQL: runtime containment, authorization, immutable configuration (D-3 mode, D-6 limits, D-4 disclosure), controlled
 * status, fail-closed eligibility snapshots on the SHARED engine, and the absence of any participation or release path. Synthetic data only; the
 * approved rule exists ONLY in this disposable test database.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const SECRET = 'shuffle-fixture-access-secret';
const run = randomUUID();
const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/shuffle', platformShuffleRoutes);
app.onError(errorHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
async function http(method: string, path: string, o: { token?: string; body?: unknown; flag?: string | undefined } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined && method !== 'GET') headers.set('Content-Type', 'application/json');
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_SHUFFLE_ENABLED: o.flag } as unknown as Bindings;
  const res = await app.request(`/api/v1/platform/shuffle${path}`, { method, headers, ...(o.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(o.body) }) }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain-text 404 */ }
  return { status: res.status, ...parsed };
}

describe.skipIf(!databaseUrl)('TSH-03 Shuffle campaign foundation (real HTTP, real PostgreSQL)', () => {
  let client: Client; let repos: ReturnType<typeof createRepositories>; let adminId: string; let adminToken: string; let userToken: string; let biz: string;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const ON = 'true'; let seq = 0; let ruleId = ''; let rule2Id = '';
  const key = () => `sh_${tag}_${++seq}`.toLowerCase().slice(0, 60);
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const content = (over: Record<string, unknown> = {}) => ({
    qualificationRuleVersionId: ruleId, minParticipants: 10, maxCapacity: 100, qualificationWindowStart: iso(-3_600_000), qualificationWindowEnd: iso(86_400_000), entryAcceptanceDeadline: iso(172_800_000),
    disclosure: { en: 'The outcome is determined by the server after the entry deadline using the final number of participants and remaining inventory.' }, termsVersion: 'draft-1',
    closureConditions: 'Closes at the entry deadline.', cancellationConditions: 'May be cancelled before allocation with notice.', ...over,
  });
  const body = (over: Record<string, unknown> = {}) => ({ key: key(), mode: 'limited', ...content(), ...over });
  const customer = async () => (await repos.customers.create({ phone: `+1559${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}` })).id;
  const purchase = async (customerId: string) => {
    const m = (await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') ON CONFLICT DO NOTHING RETURNING id`, [customerId, biz]))[0]?.id ?? (await q(`SELECT id FROM business_customer_memberships WHERE customer_id=$1 AND business_id=$2`, [customerId, biz]))[0].id;
    const a = (await q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [customerId, biz, m]))[0]?.id ?? (await q(`SELECT id FROM loyalty_accounts WHERE customer_id=$1 AND business_id=$2`, [customerId, biz]))[0].id;
    return (await q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,$5,20) RETURNING id`, [biz, customerId, m, a, randomUUID()]))[0].id as string;
  };
  const mkRule = async (approved: boolean) => {
    const spec = parseQualificationSpec({ combinator: 'ALL', pathways: [{ metric: 'recorded_purchases', threshold: 1 }] });
    const k = `shuf_rule_${tag}_${++seq}`.toLowerCase().slice(0, 60);
    const id = (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,1,'customer',$2,$3,$4) RETURNING id`, [k, JSON.stringify(spec), hashSpec(spec), adminId]))[0].id as string;
    if (approved) await q(`UPDATE qualification_rule_versions SET approval_state='approved', approved_at=now(), approved_by_user_id=$2 WHERE id=$1`, [id, adminId]);
    return id;
  };
  const create = async (over: Record<string, unknown> = {}) => { const r = await http('POST', '/campaigns', { token: adminToken, flag: ON, body: body(over) }); expect(r.status, JSON.stringify(r)).toBe(201); return r.data; };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); repos = createRepositories(buildDb(client));
    const mk = async (e: string) => (await repos.users.create({ email: e, fullName: 'u', passwordHash: 'x', status: 'active' })).id;
    adminId = await mk(`sh-admin-${run}@example.test`); await q(`UPDATE users SET platform_role='admin' WHERE id=$1`, [adminId]);
    const other = await mk(`sh-user-${run}@example.test`);
    adminToken = await signAccessToken(adminId, SECRET); userToken = await signAccessToken(other, SECRET);
    biz = (await repos.businesses.create({ name: `Shuffle ${tag}`, slug: `sh-${run}` })).id;
    await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    ruleId = await mkRule(false); rule2Id = await mkRule(false);
  });
  afterAll(async () => { await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await client?.end(); });

  describe('runtime containment and authorization', () => {
    it.each([undefined, 'false', 'TRUE', '1', ' true', 'yes'])('flag %j: every path is a generic 404 BEFORE authentication, even for a platform admin; nothing is written', async (flag) => {
      for (const [m, p] of [['GET', '/campaigns'], ['POST', '/campaigns'], ['POST', `/campaigns/${randomUUID()}/versions`], ['POST', `/campaigns/${randomUUID()}/suspend`], ['POST', `/versions/${randomUUID()}/snapshots`]] as const) {
        expect((await http(m, p, { token: adminToken, flag, body: m === 'POST' ? body() : undefined })).status, `${m} ${p}`).toBe(404);
      }
      expect((await http('GET', '/campaigns', { flag })).status).toBe(404);
      expect(await q(`SELECT 1 FROM shuffle_campaigns WHERE key LIKE $1`, [`sh_${tag}%`])).toHaveLength(0);
    });
    it('with the control on: platform admin only; anonymous 401, other users 403, a cashier token denied', async () => {
      expect((await http('GET', '/campaigns', { flag: ON })).status).toBe(401);
      expect((await http('GET', '/campaigns', { token: userToken, flag: ON })).status).toBe(403);
      const cashier = await signCashierAccessToken(adminId, SECRET, { sessionId: randomUUID(), businessId: randomUUID() });
      const r = await http('GET', '/campaigns', { token: cashier, flag: ON });
      expect(r.status).toBe(403); expect(r.error?.code).toBe('CASHIER_ROUTE_DENIED');
      expect((await http('GET', '/campaigns', { token: adminToken, flag: ON })).status).toBe(200);
    });
    it('there is NO participation, invitation, selection, allocation, winner or release route', async () => {
      const c = await create();
      for (const [m, p] of [['POST', '/entries'], ['POST', '/participate'], ['POST', `/campaigns/${c.campaign.id}/publish`], ['POST', `/campaigns/${c.campaign.id}/allocate`], ['POST', `/campaigns/${c.campaign.id}/select`], ['GET', `/campaigns/${c.campaign.id}/winners`], ['POST', '/invitations']] as const) {
        expect((await http(m, p, { token: adminToken, flag: ON, body: {} })).status, `${m} ${p}`).toBe(404);
      }
    });
  });

  describe('immutable configuration', () => {
    it('stores required limits, mode and a hashed disclosure; refuses invalid limits, dates, disclosure, rules and duplicate keys', async () => {
      const c = await create({ mode: 'guaranteed' });
      expect(c.campaign).toMatchObject({ mode: 'guaranteed', status: 'draft' });
      expect(c.version).toMatchObject({ version: 1, mode: 'guaranteed', releaseState: 'not_released', minParticipants: 10, maxCapacity: 100 });
      expect(c.version.disclosureHash).toMatch(/^[0-9a-f]{64}$/);
      for (const bad of [{ minParticipants: 0 }, { minParticipants: 50, maxCapacity: 10 }, { minParticipants: 1.5 }, { qualificationWindowEnd: iso(-7_200_000) }, { disclosure: { ar: 'فقط' } }, { disclosure: { en: 'x', zz: 'y' } }, { qualificationRuleVersionId: randomUUID() }, { mode: 'raffle' }, { extra: 1 }]) {
        const r = await http('POST', '/campaigns', { token: adminToken, flag: ON, body: body(bad) });
        expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      }
      const k = key(); await http('POST', '/campaigns', { token: adminToken, flag: ON, body: body({ key: k }) });
      expect((await http('POST', '/campaigns', { token: adminToken, flag: ON, body: body({ key: k }) })).status).toBe(409);
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'shuffle_campaign.created' AND entity_id = $1`, [c.campaign.id])).toHaveLength(1);
    });
    it('versions append (v2) and are immutable; the mode can never change; no release state other than not_released exists', async () => {
      const c = await create(); const id = c.campaign.id as string;
      const v2 = await http('POST', `/campaigns/${id}/versions`, { token: adminToken, flag: ON, body: content({ maxCapacity: 200 }) });
      expect(v2.status, JSON.stringify(v2)).toBe(201); expect(v2.data.version).toBe(2); expect(v2.data.mode).toBe('limited');
      await expect(q(`UPDATE shuffle_campaign_versions SET max_capacity = 5 WHERE id = $1`, [v2.data.id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`DELETE FROM shuffle_campaign_versions WHERE id = $1`, [v2.data.id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`UPDATE shuffle_campaigns SET mode = 'guaranteed' WHERE id = $1`, [id])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`UPDATE shuffle_campaigns SET key = 'renamed_key' WHERE id = $1`, [id])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`DELETE FROM shuffle_campaigns WHERE id = $1`, [id])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`UPDATE shuffle_campaign_versions SET release_state = 'released' WHERE id = $1`, [v2.data.id])).rejects.toThrow();
      await expect(q(`INSERT INTO shuffle_campaign_versions (campaign_id, mode, version, qualification_rule_version_id, min_participants, max_capacity, qualification_window_start, qualification_window_end, entry_acceptance_deadline, disclosure, disclosure_hash, terms_version, closure_conditions, cancellation_conditions, content_hash, release_state, created_by_user_id)
        VALUES ($1,'limited',9,$2,1,2, now(), now() + interval '1 day', now() + interval '2 day', '{"en":"x"}', repeat('a',64), 't','c','c', repeat('b',64), 'released', $3)`, [id, ruleId, adminId])).rejects.toThrow(/not_released/);
      await expect(q(`INSERT INTO shuffle_campaign_versions (campaign_id, mode, version, qualification_rule_version_id, min_participants, max_capacity, qualification_window_start, qualification_window_end, entry_acceptance_deadline, disclosure, disclosure_hash, terms_version, closure_conditions, cancellation_conditions, content_hash, created_by_user_id)
        VALUES ($1,'guaranteed',9,$2,1,2, now(), now() + interval '1 day', now() + interval '2 day', '{"en":"x"}', repeat('a',64), 't','c','c', repeat('b',64), $3)`, [id, ruleId, adminId])).rejects.toThrow(/foreign key/i); // a version cannot carry a different mode than its campaign
      for (const t of ['shuffle_campaigns', 'shuffle_campaign_versions', 'shuffle_eligibility_snapshots']) await expect(q(`TRUNCATE ${t}`), t).rejects.toThrow();
    });
    it('controlled status: suspend/cancel need a reason, resume works, cancelled is final, suspended campaigns take no new version, all audited and idempotent', async () => {
      const c = await create(); const id = c.campaign.id as string;
      expect((await http('POST', `/campaigns/${id}/suspend`, { token: adminToken, flag: ON, body: {} })).status).toBe(400);
      const s = await http('POST', `/campaigns/${id}/suspend`, { token: adminToken, flag: ON, body: { reason: 'Investigating a fraud signal.' } });
      expect(s.status, JSON.stringify(s)).toBe(200); expect(s.data.status).toBe('suspended');
      expect((await http('POST', `/campaigns/${id}/suspend`, { token: adminToken, flag: ON, body: { reason: 'again' } })).data.status).toBe('suspended');
      const refused = await http('POST', `/campaigns/${id}/versions`, { token: adminToken, flag: ON, body: content() });
      expect(refused.status).toBe(409); expect(refused.error?.code).toBe('CAMPAIGN_NOT_DRAFT');
      expect((await http('POST', `/campaigns/${id}/resume`, { token: adminToken, flag: ON })).data.status).toBe('draft');
      const x = await http('POST', `/campaigns/${id}/cancel`, { token: adminToken, flag: ON, body: { reason: 'Withdrawn before any invitation.' } });
      expect(x.data.status).toBe('cancelled');
      const back = await http('POST', `/campaigns/${id}/resume`, { token: adminToken, flag: ON });
      expect(back.status).toBe(409); expect(back.error?.code).toBe('CAMPAIGN_TRANSITION_NOT_ALLOWED');
      expect(await q(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action IN ('shuffle_campaign.suspended','shuffle_campaign.resumed','shuffle_campaign.cancelled')`, [id])).toHaveLength(3);
    });
  });

  describe('eligibility snapshots on the shared engine (fail closed)', () => {
    it('with the referenced rule NOT approved, no snapshot is recorded', async () => {
      const c = await create(); const cust = await customer(); await purchase(cust);
      const r = await http('POST', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON, body: { customerId: cust } });
      expect(r.status).toBe(409); expect(r.error?.code).toBe('QUALIFICATION_NOT_APPROVED');
      expect(await q(`SELECT 1 FROM shuffle_eligibility_snapshots WHERE campaign_version_id = $1`, [c.version.id])).toHaveLength(0);
    });
    it('with a synthetic APPROVED rule: records qualified and not-qualified once each (immutable), counts only, admits nobody', async () => {
      const approved = await mkRule(true);
      const c = await create({ qualificationRuleVersionId: approved });
      const yes = await customer(); await purchase(yes); const no = await customer();
      const a = await http('POST', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON, body: { customerId: yes } });
      expect(a.status, JSON.stringify(a)).toBe(201); expect(a.data.qualified).toBe(true);
      const b = await http('POST', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON, body: { customerId: no } });
      expect(b.data.qualified).toBe(false);
      const again = await http('POST', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON, body: { customerId: yes } });
      expect(again.status).toBe(200); expect(again.data.created).toBe(false);
      const counts = await http('GET', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON });
      expect(counts.data).toEqual({ qualified: 1, notQualified: 1 });
      expect(JSON.stringify(counts.data)).not.toContain(yes);
      const [row] = await q(`SELECT * FROM shuffle_eligibility_snapshots WHERE customer_id = $1`, [yes]);
      expect(row.evidence).toMatchObject({ evidenceLevel: 'recorded', ruleVersionId: approved });
      await expect(q(`UPDATE shuffle_eligibility_snapshots SET qualified = false WHERE id = $1`, [row.id])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`DELETE FROM shuffle_eligibility_snapshots WHERE id = $1`, [row.id])).rejects.toThrow(/APPEND_ONLY/);
      // a snapshot consumes no evidence and awards nothing
      expect(await q(`SELECT 1 FROM qualification_evidence_consumptions WHERE consumer_kind = 'campaign'`)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM tentaship_badge_awards WHERE customer_id = $1`, [yes])).toHaveLength(0);
    });
    it('evidence outside the campaign qualification window never counts; a suspended campaign records nothing; an unknown customer id is refused', async () => {
      const approved = await mkRule(true);
      const c = await create({ qualificationRuleVersionId: approved, qualificationWindowStart: iso(3_600_000), qualificationWindowEnd: iso(86_400_000), entryAcceptanceDeadline: iso(172_800_000) });
      const early = await customer(); await purchase(early); // happened before the window opens
      const r = await http('POST', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON, body: { customerId: early } });
      expect(r.data.qualified).toBe(false);
      await http('POST', `/campaigns/${c.campaign.id}/suspend`, { token: adminToken, flag: ON, body: { reason: 'pause' } });
      const blocked = await http('POST', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON, body: { customerId: await customer() } });
      expect(blocked.status).toBe(409); expect(blocked.error?.code).toBe('CAMPAIGN_NOT_DRAFT');
      expect((await http('POST', `/versions/${c.version.id}/snapshots`, { token: adminToken, flag: ON, body: { customerId: randomUUID() } })).status).toBeGreaterThanOrEqual(400);
      void rule2Id;
    });
  });
});
