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
import { platformTentashipBadgeRoutes } from '../../src/platform/tentaship-badge.routes';
import { signAccessToken, signCashierAccessToken } from '../../src/auth/jwt';

/** TB-02 against real PostgreSQL: definition lifecycle, versioning, closed rules, database guards and runtime containment. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

const SECRET = 'badge-fixture-access-secret';
const run = randomUUID().replace(/[0-9-]/g, (d) => 'abcdefghijk'[(d.charCodeAt(0)) % 11] as string).slice(0, 12);
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/tentaship-badges', platformTentashipBadgeRoutes);
app.onError(errorHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
async function http(method: string, path: string, opts: { token?: string; body?: unknown; flag?: string | undefined } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_BADGES_ENABLED: opts.flag } as unknown as Bindings;
  const res = await app.request(`/api/v1/platform/tentaship-badges${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* generic plain-text 404 of an unmounted path */ }
  return { status: res.status, ...parsed };
}

describe.skipIf(!databaseUrl)('TB-02 Tentaship Badges definitions (real HTTP, real PostgreSQL)', () => {
  let client: Client; let adminToken: string; let userToken: string; let adminId: string;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const ON = 'true';
  const body = (key: string, over: Record<string, unknown> = {}) => ({
    key, participantType: 'customer', names: { en: 'First survey', ar: 'أول استبيان' }, descriptions: { en: 'Completed a Community survey.' },
    rule: { metric: 'community_survey_completions', threshold: 1 }, ...over,
  });
  let n = 0; const key = () => `bd_${run}_${++n}`.toLowerCase();

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect();
    const repos = createRepositories(buildDb(client));
    adminId = (await repos.users.create({ email: `bd-admin-${run}@example.test`, fullName: 'admin', passwordHash: 'x', status: 'active' })).id;
    await q(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [adminId]);
    const other = (await repos.users.create({ email: `bd-user-${run}@example.test`, fullName: 'user', passwordHash: 'x', status: 'active' })).id;
    adminToken = await signAccessToken(adminId, SECRET); userToken = await signAccessToken(other, SECRET);
  });
  afterAll(async () => { await client?.end(); });

  describe('runtime containment (TENTASHIP_BADGES_ENABLED)', () => {
    it.each([undefined, 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ', '', 'enabled'])('flag %j: every path is a generic 404 BEFORE authentication, even for a platform admin', async (flag) => {
      for (const [method, path] of [['GET', '/definitions'], ['POST', '/definitions'], ['POST', `/definitions/${randomUUID()}/versions`], ['POST', `/versions/${randomUUID()}/activate`], ['POST', `/versions/${randomUUID()}/retire`]] as const) {
        const r = await http(method, path, { token: adminToken, body: method === 'POST' ? body(key()) : undefined, flag });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
      const anon = await http('GET', '/definitions', { flag });
      expect(anon.status).toBe(404); // not 401: nothing is discoverable
    });

    it('nothing was written while the control was off', async () => {
      expect(await q(`SELECT 1 FROM tentaship_badge_definitions WHERE key LIKE $1`, [`bd_${run}%`])).toHaveLength(0);
    });

    it('with the control on, platform admin only: anonymous 401, non-admin 403, cashier token denied', async () => {
      expect((await http('GET', '/definitions', { flag: ON })).status).toBe(401);
      expect((await http('GET', '/definitions', { token: userToken, flag: ON })).status).toBe(403);
      const cashier = await signCashierAccessToken(adminId, SECRET, { sessionId: randomUUID(), businessId: randomUUID() });
      const denied = await http('GET', '/definitions', { token: cashier, flag: ON });
      expect(denied.status).toBe(403); expect(denied.error?.code).toBe('CASHIER_ROUTE_DENIED');
      expect((await http('GET', '/definitions', { token: adminToken, flag: ON })).status).toBe(200);
    });
  });

  describe('definitions and versions', () => {
    it('creates a definition with a draft v1 that awards nothing, and audits it', async () => {
      const k = key();
      const r = await http('POST', '/definitions', { token: adminToken, body: body(k), flag: ON });
      expect(r.status, JSON.stringify(r)).toBe(201);
      expect(r.data.version).toMatchObject({ version: 1, status: 'draft' });
      expect(await q(`SELECT 1 FROM tentaship_badge_awards`)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM audit_log WHERE action = 'tentaship_badge.definition_created' AND entity_id = $1`, [r.data.definition.id])).toHaveLength(1);
      expect((await http('POST', '/definitions', { token: adminToken, body: body(k), flag: ON })).status).toBe(409);
    });

    it('refuses unapproved metrics, wrong participant types, extra fields, bad keys and a missing English name', async () => {
      const blocked = await http('POST', '/definitions', { token: adminToken, body: body(key(), { rule: { metric: 'verified_customer_referrals', threshold: 100 } }), flag: ON });
      expect(blocked.status).toBe(422); expect(blocked.error?.code).toBe('BADGE_METRIC_BLOCKED');
      const purchase = await http('POST', '/definitions', { token: adminToken, body: body(key(), { rule: { metric: 'qualifying_purchases_at_business', threshold: 5 } }), flag: ON });
      expect(purchase.error?.code).toBe('BADGE_METRIC_BLOCKED');
      expect((await http('POST', '/definitions', { token: adminToken, body: body(key(), { participantType: 'business' }), flag: ON })).error?.code).toBe('BADGE_METRIC_PARTICIPANT_MISMATCH');
      expect((await http('POST', '/definitions', { token: adminToken, body: body(key(), { rule: { metric: 'community_survey_completions', threshold: 1, script: 'x' } }), flag: ON })).status).toBe(400);
      expect((await http('POST', '/definitions', { token: adminToken, body: body('Bad Key!'), flag: ON })).status).toBe(400);
      expect((await http('POST', '/definitions', { token: adminToken, body: body(key(), { names: { ar: 'فقط' } }), flag: ON })).status).toBe(400);
      expect((await http('POST', '/definitions', { token: adminToken, body: body(key(), { names: { en: 'x', zz: 'y' } }), flag: ON })).status).toBe(400);
    });

    it('activation is exclusive and idempotent; a new version retires the previous one; retired versions never come back', async () => {
      const created = await http('POST', '/definitions', { token: adminToken, body: body(key()), flag: ON });
      const v1 = created.data.version.id as string; const defId = created.data.definition.id as string;
      const a1 = await http('POST', `/versions/${v1}/activate`, { token: adminToken, flag: ON });
      expect(a1.data.status).toBe('active');
      expect((await http('POST', `/versions/${v1}/activate`, { token: adminToken, flag: ON })).data.status).toBe('active');
      const v2 = (await http('POST', `/definitions/${defId}/versions`, { token: adminToken, flag: ON, body: { names: { en: 'First survey v2' }, descriptions: {}, rule: { metric: 'community_survey_completions', threshold: 2 } } })).data;
      expect(v2.version).toBe(2);
      // concurrent activation of the same draft: exactly one active at the end
      await Promise.all([http('POST', `/versions/${v2.id}/activate`, { token: adminToken, flag: ON }), http('POST', `/versions/${v2.id}/activate`, { token: adminToken, flag: ON })]);
      const rows = await q(`SELECT version, status FROM tentaship_badge_definition_versions WHERE definition_id = $1 ORDER BY version`, [defId]);
      expect(rows).toEqual([{ version: 1, status: 'retired' }, { version: 2, status: 'active' }]);
      const back = await http('POST', `/versions/${v1}/activate`, { token: adminToken, flag: ON });
      expect(back.status).toBe(409); expect(back.error?.code).toBe('BADGE_VERSION_NOT_DRAFT');
      expect((await http('POST', `/versions/${v2.id}/retire`, { token: adminToken, flag: ON })).data.status).toBe('retired');
      expect((await http('POST', `/versions/${v2.id}/retire`, { token: adminToken, flag: ON })).data.status).toBe('retired');
    });
  });

  describe('database guards', () => {
    it('version content is immutable, definitions and ledgers are append-only, nothing can be deleted or truncated', async () => {
      const created = await http('POST', '/definitions', { token: adminToken, body: body(key()), flag: ON });
      const v = created.data.version.id as string; const d = created.data.definition.id as string;
      await expect(q(`UPDATE tentaship_badge_definition_versions SET rule = '{"metric":"community_survey_completions","threshold":9}' WHERE id = $1`, [v])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`UPDATE tentaship_badge_definition_versions SET names = '{"en":"x"}' WHERE id = $1`, [v])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`DELETE FROM tentaship_badge_definition_versions WHERE id = $1`, [v])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`INSERT INTO tentaship_badge_definition_versions (definition_id, version, status, names, descriptions, rule, rule_hash, created_by_user_id, activated_at) VALUES ($1, 9, 'active', '{"en":"x"}', '{}', '{}', repeat('a',64), $2, now())`, [d, adminId])).rejects.toThrow(/IMMUTABLE/);
      await expect(q(`UPDATE tentaship_badge_definitions SET key = 'renamed_key' WHERE id = $1`, [d])).rejects.toThrow(/APPEND_ONLY/);
      await expect(q(`DELETE FROM tentaship_badge_definitions WHERE id = $1`, [d])).rejects.toThrow(/APPEND_ONLY/);
      for (const t of ['tentaship_badge_definitions', 'tentaship_badge_definition_versions', 'tentaship_badge_awards', 'tentaship_badge_revocations']) {
        await expect(q(`TRUNCATE ${t}`), t).rejects.toThrow();
      }
    });

    it('the database also rejects an award whose version belongs to another definition or whose participant type disagrees', async () => {
      const c1 = (await http('POST', '/definitions', { token: adminToken, body: body(key()), flag: ON })).data;
      const c2 = (await http('POST', '/definitions', { token: adminToken, body: body(key(), { participantType: 'business', rule: { metric: 'published_business_posts', threshold: 1 } }), flag: ON })).data;
      const customer = (await q(`INSERT INTO customers (phone) VALUES ($1) RETURNING id`, [`+1559${Math.floor(Math.random() * 1e7).toString().padStart(7, '3')}`]))[0].id;
      const award = (def: string, ver: string, type: string) => q(
        `INSERT INTO tentaship_badge_awards (definition_id, definition_version_id, participant_type, customer_id, evidence_kind, evidence_ref, evidence_hash, evidence) VALUES ($1,$2,$3,$4,'k',$5,repeat('b',64),'{}')`,
        [def, ver, type, customer, randomUUID()]);
      await expect(award(c1.definition.id, c2.version.id, 'customer')).rejects.toThrow(/foreign key/i); // version of another definition
      await expect(award(c2.definition.id, c2.version.id, 'customer')).rejects.toThrow(/foreign key/i); // business definition, customer participant
    });
  });
});
