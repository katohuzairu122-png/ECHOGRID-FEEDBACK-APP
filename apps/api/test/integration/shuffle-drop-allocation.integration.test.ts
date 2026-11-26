import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import type { Bindings } from '../../src/config/env';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { platformShuffleDropRoutes } from '../../src/platform/shuffle-drop-link.routes';
import { ShuffleDropAllocationService } from '../../src/shuffle/shuffle-drop-allocation.service';
import { signCashierAccessToken } from '../../src/auth/jwt';
import { iso, makeFixtures, SECRET } from './helpers/tentaship-fixtures';

/** TSH-04: selection -> reservation -> allocation orchestration against real PostgreSQL. Synthetic data only; nothing is collected, fulfilled or returned. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/shuffle-drops', platformShuffleDropRoutes);
app.onError(errorHandler);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
type Flags = { shuffle?: string | undefined; drops?: string | undefined };
async function http(method: string, path: string, o: { token?: string | undefined; body?: unknown; flags?: Flags } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = []; const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined && method !== 'GET') headers.set('Content-Type', 'application/json');
  const f = o.flags ?? { shuffle: 'true', drops: 'true' };
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_SHUFFLE_ENABLED: f.shuffle, TENTASHIP_DROPS_ENABLED: f.drops } as unknown as Bindings;
  const res = await app.request(`/api/v1/platform/shuffle-drops${path}`, { method, headers, ...(o.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(o.body) }) }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text(); let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain 404 */ }
  return { status: res.status, ...parsed };
}

describe.skipIf(!databaseUrl)('TSH-04 selection -> allocation integration (real HTTP, real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>;
  let admin: { id: string; token: string }; let reviewer: { id: string; token: string }; let plain: { id: string; token: string };
  let biz: string; let rule: string;
  const body = (sponsorshipId: string) => ({ sponsorshipId, holdExpiresAt: iso(3_600_000) });
  const alloc = (versionId: string, sponsorshipId: string, flags?: Flags, token = admin.token) => http('POST', `/versions/${versionId}/synthetic/allocate-to-drop`, { token, body: body(sponsorshipId), flags });
  const setup = async (entries: number, quantity: number, winners = entries) => {
    const s = await f.shuffleScenario({ creatorId: admin.id, businessId: biz, ruleId: rule, entries, min: 1 });
    await f.part.runSyntheticSelection(s.versionId, winners, f.ctx(admin.id));
    const d = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: biz, ruleId: rule, quantity });
    return { ...s, sponsorshipId: d.sponsorshipId };
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client);
    admin = await f.user('sd-admin'); reviewer = await f.user('sd-reviewer'); plain = await f.user('sd-plain', false);
    biz = await f.business('sd'); rule = await f.rule(admin.id);
  });
  afterAll(async () => { await client?.end(); });

  it('FULL LIFECYCLE: selected entries are reserved, allocated and linked; surplus is reported inventory_exhausted; allocated units are never returned; replay resumes', async () => {
    const s = await setup(4, 2, 3);
    const r = await alloc(s.versionId, s.sponsorshipId); expect(r.status, JSON.stringify(r)).toBe(200);
    expect(r.data.selected).toBe(3); expect(r.data.linked).toBe(2);
    expect(r.data.outcomes.map((o: { outcome: string }) => o.outcome).sort()).toEqual(['inventory_exhausted', 'linked', 'linked']);
    const inv = (await f.q(`SELECT * FROM drop_inventory WHERE sponsorship_id=$1`, [s.sponsorshipId]))[0]; expect(Number(inv.allocated)).toBe(2); expect(Number(inv.reserved)).toBe(0);
    const links = await f.q(`SELECT a.*, r.status FROM shuffle_drop_allocations a JOIN drop_reservations r ON r.id = a.reservation_id WHERE a.campaign_version_id=$1`, [s.versionId]);
    expect(links).toHaveLength(2); expect(links.every((l) => l.status === 'allocated' && l.synthetic === true)).toBe(true);
    const st = await http('GET', `/versions/${s.versionId}/status`, { token: admin.token });
    expect(st.data).toMatchObject({ selectionRecorded: true, selected: 3, linked: 2, allocated: 2, collected: 0 }); expect(JSON.stringify(st.data)).not.toMatch(/customer|entryId/i);
    // replay: no duplicates, allocated units untouched, exhausted entry still exhausted
    const again = await alloc(s.versionId, s.sponsorshipId);
    expect(again.data.outcomes.filter((o: { outcome: string }) => o.outcome === 'already_linked')).toHaveLength(2); expect(again.data.linked).toBe(2);
    expect(await f.q(`SELECT 1 FROM shuffle_drop_allocations WHERE campaign_version_id=$1`, [s.versionId])).toHaveLength(2);
    expect(Number((await f.q(`SELECT allocated FROM drop_inventory WHERE sponsorship_id=$1`, [s.sponsorshipId]))[0].allocated)).toBe(2);
  });

  it('GUARANTEED mode reports a shortfall instead of silently dropping entries', async () => {
    const sc = await f.shuffleScenario({ creatorId: admin.id, businessId: biz, ruleId: rule, entries: 2, mode: 'guaranteed', min: 1 });
    await f.part.runSyntheticSelection(sc.versionId, 2, f.ctx(admin.id));
    const d = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: biz, ruleId: rule, quantity: 1 });
    const r = await alloc(sc.versionId, d.sponsorshipId); expect(r.data.guaranteedModeShortfall).toBe(1); expect(r.data.linked).toBe(1);
  });

  it('CONTROLS: needs BOTH flags exactly "true" (generic 404 before auth); plain user and cashier denied; no selection -> 409', async () => {
    const s = await setup(1, 1);
    for (const flags of [{ shuffle: 'true' }, { drops: 'true' }, { shuffle: 'TRUE', drops: 'true' }, {}] as Flags[]) expect((await alloc(s.versionId, s.sponsorshipId, flags, '')).status).toBe(404);
    expect((await alloc(s.versionId, s.sponsorshipId, undefined, plain.token)).status).toBe(403);
    const cashier = await signCashierAccessToken({ cashierId: crypto.randomUUID(), businessId: biz, sessionId: crypto.randomUUID(), permissions: [] } as never, SECRET).catch(() => 'bad');
    expect([401, 403, 404]).toContain((await alloc(s.versionId, s.sponsorshipId, undefined, cashier)).status);
    const noSel = await f.shuffleScenario({ creatorId: admin.id, businessId: biz, ruleId: rule, entries: 1, min: 1 });
    const r = await alloc(noSel.versionId, s.sponsorshipId); expect(r.status).toBe(409); expect(r.error?.code).toBe('SELECTION_NOT_RECORDED');
  });

  it('DB BACKSTOPS: non-selected entry rejected; rows are append-only; TRUNCATE denied; uniqueness per entry and reservation', async () => {
    const s = await setup(3, 3, 1);
    const sel = (await f.q(`SELECT id, selected_entry_ids FROM shuffle_selection_results WHERE campaign_version_id=$1`, [s.versionId]))[0];
    const loser = s.entryIds.findIndex((e) => !(sel.selected_entry_ids as string[]).includes(e));
    const cid = s.customers[loser]!; const entry = s.entryIds[loser]!;
    const res = await f.drops.reserve(s.sponsorshipId, cid, new Date(Date.now() + 3_600_000), f.ctx(reviewer.id)); await f.drops.allocate(res.reservation.id, f.ctx(reviewer.id));
    await expect(f.q(`INSERT INTO shuffle_drop_allocations (selection_result_id,campaign_version_id,entry_id,customer_id,sponsorship_id,reservation_id,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [sel.id, s.versionId, entry, cid, s.sponsorshipId, res.reservation.id, admin.id])).rejects.toThrow(/NOT_ALLOWED/);
    await alloc(s.versionId, s.sponsorshipId);
    const row = (await f.q(`SELECT id FROM shuffle_drop_allocations WHERE campaign_version_id=$1`, [s.versionId]))[0];
    await expect(f.q(`UPDATE shuffle_drop_allocations SET synthetic = true WHERE id=$1`, [row.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`DELETE FROM shuffle_drop_allocations WHERE id=$1`, [row.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`TRUNCATE shuffle_drop_allocations`)).rejects.toThrow();
  });

  it('CONCURRENCY: two simultaneous callers (separate connections) never duplicate or over-allocate', async () => {
    const s = await setup(6, 4);
    const mk = async () => { const c = new Client({ connectionString: databaseUrl }); await c.connect(); return c; };
    const [c1, c2] = [await mk(), await mk()];
    try {
      const svc = (c: Client) => new ShuffleDropAllocationService(makeFixtures(c).db);
      const hold = new Date(Date.now() + 3_600_000);
      const [a, b] = await Promise.all([svc(c1).allocateSelected(s.versionId, s.sponsorshipId, hold, f.ctx(admin.id)), svc(c2).allocateSelected(s.versionId, s.sponsorshipId, hold, f.ctx(admin.id))]);
      expect(a.outcomes.length + b.outcomes.length).toBe(12);
    } finally { await c1.end(); await c2.end(); }
    const n = Number((await f.q(`SELECT count(*)::int n FROM shuffle_drop_allocations WHERE campaign_version_id=$1`, [s.versionId]))[0].n);
    expect(n).toBe(4);
    expect(Number((await f.q(`SELECT count(*)::int n FROM (SELECT entry_id FROM shuffle_drop_allocations GROUP BY entry_id HAVING count(*)>1) x`))[0].n)).toBe(0);
    const inv = (await f.q(`SELECT * FROM drop_inventory WHERE sponsorship_id=$1`, [s.sponsorshipId]))[0]; expect(Number(inv.allocated)).toBe(4); expect(Number(inv.reserved)).toBe(0);
  });

  it('INJECTED FAILURE: a failure after reservation rolls the whole entry back (no stranded reservation); a re-run completes it', async () => {
    const s = await setup(2, 2); const victim = s.entryIds[0]!;
    await f.q(`CREATE OR REPLACE FUNCTION sd_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entry_id = '${victim}'::uuid THEN RAISE EXCEPTION 'injected_failure'; END IF; RETURN NEW; END $$`);
    await f.q(`CREATE TRIGGER aaa_sd_fail BEFORE INSERT ON shuffle_drop_allocations FOR EACH ROW EXECUTE FUNCTION sd_fail()`);
    try {
      const r = await alloc(s.versionId, s.sponsorshipId);
      expect(r.data.outcomes.find((o: { entryId: string }) => o.entryId === victim).outcome).toBe('failed'); expect(r.data.linked).toBe(1);
      const vc = s.customers[s.entryIds.indexOf(victim)]!;
      expect(await f.q(`SELECT 1 FROM drop_reservations WHERE sponsorship_id=$1 AND customer_id=$2`, [s.sponsorshipId, vc])).toHaveLength(0);
      expect(Number((await f.q(`SELECT reserved FROM drop_inventory WHERE sponsorship_id=$1`, [s.sponsorshipId]))[0].reserved)).toBe(0);
    } finally { await f.q(`DROP TRIGGER aaa_sd_fail ON shuffle_drop_allocations`); await f.q(`DROP FUNCTION sd_fail()`); }
    const r2 = await alloc(s.versionId, s.sponsorshipId); expect(r2.data.linked).toBe(2);
  });
});
