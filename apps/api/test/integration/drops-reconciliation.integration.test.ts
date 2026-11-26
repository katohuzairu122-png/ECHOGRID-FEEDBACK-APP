import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import type { Bindings } from '../../src/config/env';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { platformDropsRoutes } from '../../src/platform/drops.routes';
import { platformGovernanceRoutes } from '../../src/platform/governance.routes';
import { signCashierAccessToken } from '../../src/auth/jwt';
import { DROP_METRIC_DEFINITIONS, DROP_METRIC_KINDS, TentashipAnalytics } from '../../src/analytics/tentaship-analytics';
import { checkDropInventory } from '../../src/analytics/drop-inventory-reconciliation';
import { buildDb } from '../../src/db/client';
import { DropSponsorshipService } from '../../src/drops/drop-sponsorship.service';
import { makeFixtures, SECRET } from './helpers/tentaship-fixtures';

/**
 * TDP-04: canonical inventory reconciliation, current-vs-historical metrics, identity-free event references, containment and read-only behaviour, against real
 * PostgreSQL with synthetic data. Every figure is checked against raw canonical rows, and every tamper is applied in the disposable database only.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/drops', platformDropsRoutes);
app.route('/api/v1/platform/governance', platformGovernanceRoutes);
app.onError(errorHandler);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string } };
type Flags = { shuffle?: string | undefined; drops?: string | undefined };
async function call(method: string, path: string, o: { token?: string | undefined; flags?: Flags | undefined; body?: unknown; accept?: string } = {}): Promise<{ status: number; type: string } & Envelope> {
  const pending: Promise<unknown>[] = []; const headers = new Headers(); if (o.token) headers.set('Authorization', `Bearer ${o.token}`); if (o.accept) headers.set('Accept', o.accept);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const f = o.flags ?? { shuffle: 'true', drops: 'true' };
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_SHUFFLE_ENABLED: f.shuffle, TENTASHIP_DROPS_ENABLED: f.drops } as unknown as Bindings;
  const res = await app.request(path, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending); const text = await res.text(); let parsed: Envelope = {}; try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain */ }
  return { status: res.status, type: res.headers.get('content-type') ?? '', ...parsed };
}
const D = '/api/v1/platform/drops'; const G = '/api/v1/platform/governance';
const ACK = { syntheticAcknowledged: true };

describe.skipIf(!databaseUrl)('TDP-04 inventory reconciliation, analytics and containment (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>; let admin: { id: string; token: string }; let reviewer: { id: string; token: string }; let plain: { id: string; token: string };
  let biz: string; let bizB: string; let rule: string; let an: TentashipAnalytics;
  const scen = (o: { quantity: number; reserve?: number; allocate?: number; windowMs?: number }) => f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: biz, ruleId: rule, quantity: o.quantity, ...(o.reserve !== undefined ? { reserve: o.reserve } : {}), ...(o.allocate !== undefined ? { allocate: o.allocate } : {}), ...(o.windowMs !== undefined ? { collectionWindowEndMs: o.windowMs } : {}) });
  const rec = (id: string) => checkDropInventory(f.db, id);
  const counts = async (id: string) => (await f.q(`SELECT (SELECT count(*)::int FROM drop_reservations WHERE sponsorship_id=$1) r, (SELECT count(*)::int FROM drop_events WHERE sponsorship_id=$1) e, (SELECT reserved||'/'||allocated||'/'||collected||'/'||expired FROM drop_inventory WHERE sponsorship_id=$1) i`, [id]))[0];
  const tamper = async (trigger: string, table: string, sql: string, params: unknown[]) => { await f.q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`); try { await f.q(sql, params); } finally { await f.q(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`); } };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client); an = new TentashipAnalytics(f.db);
    admin = await f.user('rc-admin'); reviewer = await f.user('rc-reviewer'); plain = await f.user('rc-plain', false);
    biz = await f.business('rc-a'); bizB = await f.business('rc-b');
    await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    rule = await f.rule(admin.id);
  });
  afterAll(async () => { await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await client?.end(); });

  it('INVENTORY: every state is counted once; current state and historical activity are kept apart; transitions are not extra units; repeats are idempotent', async () => {
    const s = await scen({ quantity: 8, reserve: 6, allocate: 3 }); const [r1, r2, , r4, r5] = s.reservationIds as [string, string, string, string, string, string];
    await f.drops.collect(r1, f.ctx(reviewer.id));                                       // 1 collected, 1 allocated, then...
    await f.drops.release(r4, 'synthetic release', f.ctx(reviewer.id));                  // 1 released hold
    const shortHold = await f.drops.reserve(s.sponsorshipId, await f.customer({ businessId: biz, purchase: true }), new Date(Date.now() + 1100), f.ctx(reviewer.id)); void shortHold;
    await new Promise((r) => setTimeout(r, 1400)); await f.drops.expireDue(s.sponsorshipId, f.ctx(reviewer.id)); // 1 expired hold
    const a = await rec(s.sponsorshipId);
    // 7 reservations ever created: 1 collected, 2 allocated, 2 still reserved (r5 and r6), 1 released, 1 expired hold
    expect(a.current).toEqual({ total: 8, reserved: 2, allocated: 2, collected: 1, expiredUnreturned: 0, available: 3 });
    expect(a.historical).toMatchObject({ reservationsCreated: 7, holdsReleased: 1, holdsExpired: 1, allocationsExpired: 0 });
    expect(a.historical!.additions).toEqual({ available: false, reason: 'INVENTORY_ADDITIONS_ARE_NOT_SUPPORTED_THE_TOTAL_IS_IMMUTABLE' });
    expect(a.ok).toBe(true); expect(a.remediation).toBe('NONE_REQUIRED'); expect(a.checks.every((c) => c.ok)).toBe(true);
    // released/expired holds are ACTIVITY, not extra balance: states of every reservation sum to the created count, and available excludes nothing that was returned twice
    const raw = await f.q(`SELECT status, count(*)::int n FROM drop_reservations WHERE sponsorship_id = $1 GROUP BY status`, [s.sponsorshipId]);
    expect(raw.reduce((x, y) => x + y.n, 0)).toBe(a.historical!.reservationsCreated);
    // repeats and idempotent calls change nothing: counts, events and inventory are identical
    const before = await counts(s.sponsorshipId);
    await f.drops.allocate(r2, f.ctx(reviewer.id)); await f.drops.collect(r1, f.ctx(reviewer.id)); await f.drops.release(r4, 'again', f.ctx(reviewer.id));
    await f.drops.expireDue(s.sponsorshipId, f.ctx(reviewer.id)); await f.drops.reserve(s.sponsorshipId, (await f.q(`SELECT customer_id FROM drop_reservations WHERE id = $1`, [r5]))[0].customer_id, new Date(Date.now() + 3_600_000), f.ctx(reviewer.id));
    expect(await counts(s.sponsorshipId)).toEqual(before);
    expect((await rec(s.sponsorshipId)).current).toEqual(a.current);
    // lifecycle transitions are not units: suspend/resume/cancel leave every inventory figure and the reservation count alone
    await f.drops.move(s.sponsorshipId, 'suspended', f.ctx(reviewer.id), { reason: 'synthetic pause' }); await f.drops.move(s.sponsorshipId, 'available', f.ctx(reviewer.id));
    expect((await rec(s.sponsorshipId)).current).toEqual(a.current);
    await f.drops.move(s.sponsorshipId, 'cancelled', f.ctx(reviewer.id), { reason: 'synthetic cancellation' });
    const c = await rec(s.sponsorshipId); expect(c.current).toEqual(a.current); expect(c.lifecycleStatus).toBe('cancelled'); expect(c.ok).toBe(true); // allocated units stay allocated after cancellation
  });

  it('an uncollected allocation is NOT returned to the pool; an allocated unit is never silently withdrawn; oversubscription and negative inventory are impossible', async () => {
    const s = await scen({ quantity: 2, reserve: 2, allocate: 2, windowMs: 1500 });
    await f.drops.collect(s.reservationIds[0]!, f.ctx(reviewer.id));
    await new Promise((r) => setTimeout(r, 1800)); await f.drops.expireDue(s.sponsorshipId, f.ctx(reviewer.id));
    const a = await rec(s.sponsorshipId);
    expect(a.current).toEqual({ total: 2, reserved: 0, allocated: 0, collected: 1, expiredUnreturned: 1, available: 0 });
    expect(a.historical).toMatchObject({ allocationsExpired: 1, holdsExpired: 0 }); expect(a.ok).toBe(true);
    await expect(f.drops.reserve(s.sponsorshipId, await f.customer({ businessId: biz, purchase: true }), new Date(Date.now() + 60_000), f.ctx(reviewer.id))).rejects.toMatchObject({ code: 'INVENTORY_EXHAUSTED' });
    // allocated unit cannot be released or withdrawn through any service path
    const t = await scen({ quantity: 2, reserve: 2, allocate: 1 });
    await expect(f.drops.release(t.reservationIds[0]!, 'sponsor withdrawal', f.ctx(reviewer.id))).rejects.toMatchObject({ code: 'RESERVATION_TRANSITION_NOT_ALLOWED' });
    await expect(f.q(`UPDATE drop_reservations SET status = 'released', status_reason = 'x' WHERE id = $1`, [t.reservationIds[0]])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    await expect(f.q(`UPDATE drop_inventory SET allocated = allocated - 1 WHERE sponsorship_id = $1`, [t.sponsorshipId])).rejects.toThrow(/INVENTORY_CONTROLLED/);
    await expect(f.q(`UPDATE drop_inventory SET reserved = -1 WHERE sponsorship_id = $1`, [t.sponsorshipId])).rejects.toThrow();
    expect((await rec(t.sponsorshipId)).current).toMatchObject({ allocated: 1, reserved: 1 });
    // concurrency: many parallel reservations on 3 units reconcile exactly
    const c = await scen({ quantity: 3 }); const customers: string[] = []; for (let i = 0; i < 8; i++) customers.push(await f.customer({ businessId: biz, purchase: true }));
    const res = await Promise.allSettled(customers.map(async (cid) => { // one connection per caller: real concurrency
      const cl = new Client({ connectionString: databaseUrl }); await cl.connect();
      try { return await new DropSponsorshipService(buildDb(cl)).reserve(c.sponsorshipId, cid, new Date(Date.now() + 60_000), f.ctx(reviewer.id)); } finally { await cl.end(); }
    }));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(res.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason?.code === 'INVENTORY_EXHAUSTED')).toBe(true);
    const cr = await rec(c.sponsorshipId); expect(cr.current).toMatchObject({ reserved: 3, available: 0 }); expect(cr.ok).toBe(true);
  });

  it('RECONCILIATION FAILURES are detected, reported with expected/actual and NEVER silently repaired; each becomes a distinct read-only signal', async () => {
    const s = await scen({ quantity: 4, reserve: 3, allocate: 1 });
    expect((await rec(s.sponsorshipId)).ok).toBe(true);
    await tamper('drop_inventory_guard_trg', 'drop_inventory', `UPDATE drop_inventory SET reserved = 0 WHERE sponsorship_id = $1`, [s.sponsorshipId]);
    await tamper('drop_events_append_only_trg', 'drop_events', `UPDATE drop_events SET event = jsonb_set(event, '{type}', '"hold_expired"') WHERE sponsorship_id = $1 AND event->>'type' = 'released'`, [s.sponsorshipId]);
    const t = await scen({ quantity: 4, reserve: 1 });
    await tamper('drop_inventory_guard_trg', 'drop_inventory', `UPDATE drop_inventory SET total_quantity = 9 WHERE sponsorship_id = $1`, [t.sponsorshipId]);
    const a = await rec(s.sponsorshipId); expect(a.ok).toBe(false); expect(a.remediation).toBe('REVIEW_REQUIRED_NO_AUTOMATIC_REPAIR');
    const failed = a.checks.filter((c) => !c.ok); const reserved = failed.find((c) => c.code === 'reserved_matches_reservations')!;
    expect(reserved).toMatchObject({ expected: 2, actual: 0 });
    const b = await rec(t.sponsorshipId); expect(b.checks.filter((c) => !c.ok).map((c) => c.code)).toEqual(expect.arrayContaining(['total_matches_approved_version']));
    // NOT repaired: running reconciliation (and analytics) again leaves the tampered counters exactly as they were
    await rec(s.sponsorshipId); await an.dropSponsorship(s.sponsorshipId); await call('GET', `${D}/sponsorships/${s.sponsorshipId}/reconciliation`, { token: admin.token });
    expect((await f.q(`SELECT reserved, total_quantity FROM drop_inventory WHERE sponsorship_id = $1`, [s.sponsorshipId]))[0]).toMatchObject({ reserved: 0 });
    expect((await f.q(`SELECT total_quantity FROM drop_inventory WHERE sponsorship_id = $1`, [t.sponsorshipId]))[0].total_quantity).toBe(9);
    // analytics reports the failure instead of hiding it
    expect((await an.dropSponsorship(s.sponsorshipId)).metrics!.reconciled).toBe(false);
    // read-only fraud signals, one per failed check; a case can start from one, and it touches no unit
    const sig = await call('GET', `/api/v1/platform/governance/signals/sponsorship/${s.sponsorshipId}`, { token: admin.token });
    expect(sig.status).toBe(200); const inv = (sig.data.signals as { code: string; key: string; refs: string[] }[]).filter((x) => x.code === 'inventory_inconsistent');
    expect(inv.length).toBeGreaterThanOrEqual(1); expect(new Set(inv.map((x) => x.key)).size).toBe(inv.length);
    const before = await counts(s.sponsorshipId);
    const made = await call('POST', `${G}/cases/from-signal`, { token: admin.token, body: { ...ACK, scope: { type: 'sponsorship', id: s.sponsorshipId }, signalKey: inv[0]!.key, subjectType: 'drop_sponsorship', subjectId: s.sponsorshipId } });
    expect(made.status, JSON.stringify(made)).toBe(201); expect(await counts(s.sponsorshipId)).toEqual(before);
    expect((await f.q(`SELECT status FROM drop_reservations WHERE id = $1`, [s.reservationIds[0]]))[0].status).toBe('allocated'); // historical allocation preserved
  });

  it('ANALYTICS: empty dataset, undefined metrics, determinism, kinds cover every metric, historical vs current separation, definitions match', async () => {
    const empty = await scen({ quantity: 5 }); const e = await an.dropSponsorship(empty.sponsorshipId);
    expect(e.metrics).toMatchObject({ total: 5, available: 5, reserved: 0, allocated: 0, collected: 0, reservationsCreated: 0, holdsReleased: 0, holdsExpired: 0, outstandingCollection: 0, reconciled: true });
    expect(e.metrics!.collectionCompletionRate).toEqual({ available: false, reason: 'NO_ALLOCATION_YET' }); // undefined, not zero
    const draft = await f.drops.create({ key: f.key('dp'), businessId: biz, productName: 'x', description: 'y', quantityTotal: 1, collectionMethod: 'm', collectionLocation: 'l', collectionWindowStart: new Date(Date.now() - 1000), collectionWindowEnd: new Date(Date.now() + 86_400_000), offerExpiresAt: new Date(Date.now() + 86_400_000), qualificationRuleVersionId: rule }, f.ctx(admin.id));
    expect(await an.dropSponsorship(draft.sponsorship.id)).toMatchObject({ metrics: null, reason: 'NO_INVENTORY_UNTIL_APPROVED' });
    expect((await rec(draft.sponsorship.id)).current).toBeNull();
    const s = await scen({ quantity: 4, reserve: 3, allocate: 2 });
    const one = await an.dropSponsorship(s.sponsorshipId); const two = await an.dropSponsorship(s.sponsorshipId);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two)); // deterministic
    expect(Object.keys(one.metrics!).sort()).toEqual(Object.keys(DROP_METRIC_DEFINITIONS).sort()); expect(Object.keys(DROP_METRIC_KINDS).sort()).toEqual(Object.keys(DROP_METRIC_DEFINITIONS).sort());
    const m0 = one.metrics!; await f.drops.release(s.reservationIds[2]!, 'synthetic release', f.ctx(reviewer.id)); const m1 = (await an.dropSponsorship(s.sponsorshipId)).metrics!;
    expect([m0.reserved, m1.reserved, m0.holdsReleased, m1.holdsReleased, m0.reservationsCreated, m1.reservationsCreated]).toEqual([1, 0, 0, 1, 3, 3]); // current moved, history added, the created count did not
    expect(m1.available).toBe(m0.available as number + 1); // the released hold is back in the pool; allocated units are not
    // matches the route
    const r = await call('GET', `${D}/sponsorships/${s.sponsorshipId}/analytics`, { token: admin.token }); expect(r.data.metrics).toEqual(JSON.parse(JSON.stringify(m1)));
    expect((await call('GET', `${D}/metric-kinds`, { token: admin.token })).data).toEqual(DROP_METRIC_KINDS);
  });

  it('EVENT REFERENCES for TSH-07: identity-free, canonical (chain rows), distinct kinds, paged; a collection is not proof of a purchase', async () => {
    const s = await scen({ quantity: 4, reserve: 3, allocate: 2 }); await f.drops.collect(s.reservationIds[0]!, f.ctx(reviewer.id)); await f.drops.release(s.reservationIds[2]!, 'synthetic release', f.ctx(reviewer.id));
    const r = await call('GET', `${D}/sponsorships/${s.sponsorshipId}/event-references`, { token: admin.token }); expect(r.status).toBe(200);
    const text = JSON.stringify(r.data);
    for (const id of [...s.customers, reviewer.id, admin.id, ...s.reservationIds]) expect(text, id).not.toContain(id); // no customer, staff or reservation identity
    const refs = r.data.references as { eventId: string; seq: number; hash: string; kind: string }[];
    const kinds = refs.map((x) => x.kind); expect(kinds.filter((k) => k === 'reserved')).toHaveLength(3); expect(kinds).toEqual(expect.arrayContaining(['allocated', 'collected', 'released', 'approved']));
    const rows = await f.q(`SELECT id, seq, hash FROM drop_events WHERE sponsorship_id = $1 ORDER BY seq`, [s.sponsorshipId]);
    for (const x of refs) expect(rows.find((y) => y.id === x.eventId)).toMatchObject({ seq: x.seq, hash: x.hash }); // every reference is one row of the append-only chain
    expect(r.data.notEvidenceOf).toEqual(expect.arrayContaining(['qualifying_purchase', 'customer_acquisition', 'revenue', 'return_on_investment', 'incremental_sales', 'customer_lifetime_value', 'sponsor_profitability']));
    const page = await call('GET', `${D}/sponsorships/${s.sponsorshipId}/event-references?afterSeq=${refs[2]!.seq}`, { token: admin.token });
    expect(page.data.references.map((x: { seq: number }) => x.seq)).toEqual(refs.filter((x) => x.seq > refs[2]!.seq).map((x) => x.seq));
    expect(JSON.stringify((await call('GET', `${D}/sponsorships/${s.sponsorshipId}/event-references`, { token: admin.token })).data)).toBe(text); // stable
    expect((await call('GET', `${D}/sponsorships/${s.sponsorshipId}/event-references?afterSeq=-1`, { token: admin.token })).status).toBe(422);
  });

  it('AUTHORIZATION, PRIVACY and CONTAINMENT: control matrix, anonymous/non-platform/cashier denied, no export or sponsor route, cross-business and small-group protection, read-only', async () => {
    const s = await scen({ quantity: 6, reserve: 2, allocate: 1 });
    const paths = [`/sponsorships/${s.sponsorshipId}/analytics`, `/sponsorships/${s.sponsorshipId}/reconciliation`, `/sponsorships/${s.sponsorshipId}/event-references`, '/metric-kinds', '/metric-definitions'];
    for (const p of paths) {
      for (const flags of [{ shuffle: 'true' }, { shuffle: 'true', drops: 'false' }, { shuffle: 'true', drops: 'TRUE' }, { shuffle: 'true', drops: '1' }, { shuffle: 'true', drops: ' true' }]) expect((await call('GET', D + p, { token: admin.token, flags })).status, `${p} ${JSON.stringify(flags)}`).toBe(404);
      expect((await call('GET', D + p, {})).status, `anon ${p}`).toBe(401);
      expect((await call('GET', D + p, { token: plain.token })).status, `plain ${p}`).toBe(403);
      const cashier = await signCashierAccessToken(admin.id, SECRET, { sessionId: '00000000-0000-4000-8000-0000000000c1', businessId: '00000000-0000-4000-8000-0000000000c2' });
      const c = await call('GET', D + p, { token: cashier }); expect(c.status, `cashier ${p}`).toBe(403); expect(c.error?.code).toBe('CASHIER_ROUTE_DENIED');
      expect((await call('GET', D + p, { token: admin.token, flags: { shuffle: 'false', drops: 'true' } })).status, `drops-only ${p}`).toBe(200); // independent controls
    }
    // no export, sponsor or write route; a format hint never changes the representation
    for (const p of ['/export', `/sponsorships/${s.sponsorshipId}/export`, `/sponsorships/${s.sponsorshipId}/analytics/export`, `/sponsorships/${s.sponsorshipId}/analytics.csv`, `/sponsors/${biz}/analytics`, `/me/sponsorships`]) expect((await call('GET', D + p, { token: admin.token })).status, p).toBe(404);
    const csv = await call('GET', `${D}/sponsorships/${s.sponsorshipId}/analytics?format=csv`, { token: admin.token, accept: 'text/csv' }); expect(csv.status).toBe(200); expect(csv.type).toContain('application/json');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await call(m, `${D}/sponsorships/${s.sponsorshipId}/reconciliation`, { token: admin.token, body: ACK })).status, m).toBe(404);
    // cross-business and small-group protection through the sponsor-scoped service (internal; no external route)
    await expect(an.dropSponsorshipForBusiness(bizB, s.sponsorshipId, { minimumGroupSize: 1 })).rejects.toMatchObject({ code: 'SPONSORSHIP_NOT_FOUND' });
    await expect(an.dropSponsorshipForBusiness(biz, s.sponsorshipId, {} as never)).rejects.toMatchObject({ code: 'THRESHOLD_REQUIRED' });
    const hidden = (await an.dropSponsorshipForBusiness(biz, s.sponsorshipId, { minimumGroupSize: 5 })).metrics as Record<string, unknown>;
    for (const k of ['reserved', 'allocated', 'collected', 'available', 'reservationsCreated', 'holdsReleased', 'holdsExpired']) expect(hidden[k], k).toEqual({ available: false, reason: 'SUPPRESSED_SMALL_GROUP' });
    // repeated filtering cannot narrow below the suppression: every call with the same threshold gives the same all-or-nothing answer
    for (let i = 0; i < 3; i++) expect(JSON.stringify((await an.dropSponsorshipForBusiness(biz, s.sponsorshipId, { minimumGroupSize: 5 })).metrics)).toBe(JSON.stringify(hidden));
    // READ-ONLY: every analytics / reconciliation / reference call leaves drop_* and governance_* tables untouched
    const snap = async () => (await f.q(`SELECT (SELECT count(*) FROM drop_events)::int de, (SELECT count(*) FROM drop_reservations)::int dr, (SELECT sum(reserved+allocated+collected+expired) FROM drop_inventory)::int di, (SELECT count(*) FROM governance_cases)::int gc, (SELECT count(*) FROM governance_events)::int ge, (SELECT count(*) FROM governance_overrides)::int go, (SELECT count(*) FROM governance_case_evidence)::int gv`))[0];
    const b = await snap();
    for (const p of paths) await call('GET', D + p, { token: admin.token }); await an.dropSponsorship(s.sponsorshipId); await rec(s.sponsorshipId); await an.dropSponsorshipForBusiness(biz, s.sponsorshipId, { minimumGroupSize: 2 });
    expect(await snap()).toEqual(b);
    // governance boundary: analytics offers no way to approve, resolve, override or withdraw
    for (const p of [`${G}/overrides/00000000-0000-4000-8000-0000000000d1/approve`, `${D}/sponsorships/${s.sponsorshipId}/withdraw`, `${D}/sponsorships/${s.sponsorshipId}/reconciliation/repair`]) expect((await call('POST', p, { token: plain.token, body: ACK })).status, p).toBeGreaterThanOrEqual(400);
  });
});
