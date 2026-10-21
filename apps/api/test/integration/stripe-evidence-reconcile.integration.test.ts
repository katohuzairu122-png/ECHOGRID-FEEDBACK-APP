import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { buildDb, type Database } from '../../src/db/client';
import {
  StripeEvidenceStore, ForensicReader, ControlEventWriter, loadKeyring, classifyEnvelope, cohortOf, runReconciliation, stripeFetchSource, ProviderHttpError, InvalidProviderPage,
  ReconcileError, deriveUcw, loadStreamEvents, coverageStateAt, slotOf, SLOT_SECONDS,
  type ProviderEventSource, type ProviderListedEvent, type ReconcileParams,
} from '../../src/billing/stripe-evidence';

/**
 * HETA-01-F1 windowed reconciliation and backfill (T18, T19) against a DISPOSABLE PostgreSQL with a fake provider.
 * Evidence is append-only; accounts and event ids are random per test so reruns do not collide.
 */
const monthsFrom = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const testKek = (c: string) => createHash('sha256').update(`heta01-f1-test-kek:${c}`).digest().toString('base64');
const ring = () => JSON.stringify({ v: 1, keys: [0, 1, 2].map(n => { const s = monthsFrom(new Date(), n); return { cohort: cohortOf(s), kek_version: 'v1', alg: 'AES-256-GCM', key: testKek(cohortOf(s)), not_before: s.toISOString(), not_after: '2100-01-01T00:00:00Z', active: true }; }) });

describe.skipIf(!process.env.DATABASE_URL)('stripe evidence reconciliation (integration, disposable database)', () => {
  const clients: Client[] = [];
  let q: Client;
  const rows = async (t: string, p: unknown[] = []) => (await q.query(t, p)).rows;
  const newDb = async (): Promise<Database> => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); clients.push(c); return buildDb(c); };
  beforeAll(async () => { q = new Client({ connectionString: process.env.DATABASE_URL }); await q.connect(); });
  afterAll(async () => { await q.end(); await Promise.all(clients.map(c => c.end().catch(() => undefined))); });

  const RETENTION = { policyVersion: 'test-v1', retainUntil: new Date(Date.now() + 365 * 86400000) };
  const acct = () => `acct_R${randomBytes(6).toString('hex')}`;
  const evtId = () => `evt_q${randomBytes(8).toString('hex')}`;
  const nowS = () => Math.floor(Date.now() / 1000);
  const raw = (id: string, created: number, over: Record<string, unknown> = {}) =>
    JSON.stringify({ id, object: 'event', type: 'customer.subscription.updated', created, livemode: false, api_version: '2026-05-27.dahlia', data: { object: { id: 'sub_r', object: 'subscription', customer: 'cus_r' } }, ...over });

  interface Fake { source: ProviderEventSource; listCalls: unknown[]; retrieveCalls: string[]; sleeps: number[] }
  const fake = (events: { id: string; created: number; raw?: string }[], o: { listError?: () => Error; retrieveError?: (id: string) => Error | null; invalidPage?: boolean; neverEnds?: boolean } = {}): Fake => {
    const f: Fake = { source: null as never, listCalls: [], retrieveCalls: [], sleeps: [] };
    const sorted = [...events].sort((a, b) => b.created - a.created);
    f.source = {
      async list(p) {
        f.listCalls.push(p);
        if (o.listError) throw o.listError();
        if (o.invalidPage) return { events: [{ id: 'not-an-event', type: 'x', created: 1 }], hasMore: false };
        const inWin = sorted.filter(e => e.created >= p.createdGte && e.created < p.createdLt);
        const start = p.startingAfter ? inWin.findIndex(e => e.id === p.startingAfter) + 1 : 0;
        const slice = inWin.slice(start, start + p.limit);
        return { events: slice.map<ProviderListedEvent>(e => ({ id: e.id, type: 'customer.subscription.updated', created: e.created })), hasMore: o.neverEnds ? true : start + p.limit < inWin.length };
      },
      async retrieve(id) {
        f.retrieveCalls.push(id);
        const err = o.retrieveError?.(id);
        if (err) throw err;
        const e = events.find(x => x.id === id);
        if (!e) throw new ProviderHttpError(404);
        return { rawBody: e.raw ?? raw(e.id, e.created), apiVersion: '2026-05-27.dahlia' };
      },
    };
    return f;
  };

  const setup = async (opts: { attest?: boolean } = {}) => {
    const a = acct();
    const db = await newDb();
    const keyring = await loadKeyring(ring(), new Date());
    const store = new StripeEvidenceStore(db, { receivingAccountId: a, keyring });
    const stream = `${a}:false`;
    const attestationId = opts.attest === false ? null : (await rows(`insert into stripe_evidence_control_events(event_kind,actor,stream,details) values ('account_provenance_verified','test',$1,'{"result":"passed"}') returning id`, [stream]))[0].id as string;
    return { a, db, store, stream, keyring, attestationId };
  };
  const run = (s: Awaited<ReturnType<typeof setup>>, f: Fake, p: Partial<ReconcileParams> = {}) =>
    runReconciliation(
      { db: s.db, store: s.store, source: f.source, receivingAccountId: s.a, livemode: false, retention: RETENTION, actor: 'test', commitSha: 'abc', sleep: async ms => { f.sleeps.push(ms); } },
      { windowStart: new Date((nowS() - 7200) * 1000), windowEnd: new Date((nowS() - 60) * 1000), pageSize: 100, maxPages: 10, maxEvents: 1000, backoffMs: 10, l2MaxAgeSeconds: 86_400, ...p },
    );
  const forensicCtx = { actor: 'test', reason: 'reconcile test' };
  const manifest = async (s: { stream: string }, runId: string) => (await rows(`select details, window_start, window_end from stripe_evidence_control_events where stream=$1 and event_kind='reconciliation_run' and details->>'runId'=$2 and details->>'state' <> 'started'`, [s.stream, runId]))[0];

  it('T18: an event never seen locally is retrieved and ingested as api_retrieval with retrieval_run_id; present events are confirmed, not re-fetched; the manifest is complete and claims no completeness', async () => {
    const s = await setup();
    const t = nowS();
    const [e1, e2, e3] = [evtId(), evtId(), evtId()];
    const shape = classifyEnvelope(raw(e3, t - 600));
    if (shape.kind !== 'ok') throw new Error('fixture');
    await s.store.captureWellFormed({ rawBody: new TextEncoder().encode(raw(e3, t - 600)), envelope: shape.envelope, signature: { headerTimestamp: 1, scheme: 'v1', secretLabel: 'p', verifiedAt: new Date(), verifierVersion: 't' }, receivedAt: new Date(), attestationEventId: s.attestationId!, retention: RETENTION });
    const f = fake([{ id: e1, created: t - 1800 }, { id: e2, created: t - 1200 }, { id: e3, created: t - 600 }]);
    const r = await run(s, f);
    expect(r).toMatchObject({ state: 'reconciled_no_known_gaps', listed: 3, presentLocally: 1, absent: 2, ingested: 2, errors: [] });
    expect([...f.retrieveCalls].sort()).toEqual([e1, e2].sort());
    const ingested = await rows(`select stripe_event_id, provenance, retrieval_run_id, sig_scheme, retrieval_api_version, verified_at from stripe_provider_events where receiving_account_id=$1 and provenance='api_retrieval'`, [s.a]);
    expect(ingested).toHaveLength(2);
    for (const row of ingested) expect(row).toMatchObject({ provenance: 'api_retrieval', retrieval_run_id: r.startedEventId, sig_scheme: null, verified_at: null, retrieval_api_version: '2026-05-27.dahlia' });
    // exact provider bytes preserved
    const reader = new ForensicReader(s.db, s.keyring);
    const id1 = (await rows(`select id from stripe_provider_events where stripe_event_id=$1`, [e1]))[0].id;
    expect(new TextDecoder().decode(await reader.readEvent(id1, forensicCtx))).toBe(raw(e1, t - 1800));
    // present event confirmed once; ingested rows carry a capture disposition marking their provenance
    expect((await rows(`select count(*)::int n from stripe_provider_event_dispositions d join stripe_provider_events e on e.id=d.event_record_id where e.stripe_event_id=$1 and d.disposition='reconciliation_confirmed'`, [e3]))[0].n).toBe(1);
    expect((await rows(`select reason_codes, actor from stripe_provider_event_dispositions where event_record_id=$1 and disposition='capture_committed'`, [id1]))[0]).toEqual({ reason_codes: ['API_RETRIEVAL'], actor: 'reconciliation' });
    // manifest
    const m = await manifest(s, r.runId);
    expect(m.details).toMatchObject({ state: 'reconciled_no_known_gaps', listed: 3, absent: 2, ingested: 2, reachedEnd: true, errorCount: 0 });
    expect(m.details.listedIdsDigest).toBe(createHash('sha256').update([e1, e2, e3].sort().join('\n')).digest('hex'));
    expect(String(m.details.statement)).toMatch(/not a complete provider history/);
    expect(JSON.stringify(m.details)).not.toMatch(/"complete(Provider)?History"/);
    expect(await rows(`select 1 from stripe_evidence_control_events where stream=$1 and event_kind='coverage_gap_unrecovered'`, [s.stream])).toHaveLength(0);
    // a second run finds everything local: no retrieval, no duplicate rows, no duplicate confirmation
    const f2 = fake([{ id: e1, created: t - 1800 }, { id: e2, created: t - 1200 }, { id: e3, created: t - 600 }]);
    const r2 = await run(s, f2);
    expect(r2).toMatchObject({ state: 'reconciled_no_known_gaps', presentLocally: 3, absent: 0, ingested: 0 });
    expect(f2.retrieveCalls).toEqual([]);
    expect((await rows(`select count(*)::int n from stripe_provider_events where receiving_account_id=$1`, [s.a]))[0].n).toBe(3);
    expect((await rows(`select count(*)::int n from stripe_provider_event_dispositions d join stripe_provider_events e on e.id=d.event_record_id where e.stripe_event_id=$1 and d.disposition='reconciliation_confirmed'`, [e3]))[0].n).toBe(1);
  });

  it('T19: hitting the page limit is incomplete, records coverage_gap_unrecovered, and the window derives as uncertified', async () => {
    const s = await setup();
    const t = nowS();
    const evs = [0, 1, 2].map(i => ({ id: evtId(), created: t - 600 * (i + 1) }));
    const r = await run(s, fake(evs), { pageSize: 1, maxPages: 2 });
    expect(r.state).toBe('incomplete');
    expect(r.truncated.pages).toBe(true);
    expect(r.errors.map(e => e.code)).toContain('PAGE_LIMIT');
    expect((await manifest(s, r.runId)).details).toMatchObject({ state: 'incomplete', reachedEnd: false });
    const gap = await rows(`select window_start, window_end, details from stripe_evidence_control_events where stream=$1 and event_kind='coverage_gap_unrecovered'`, [s.stream]);
    expect(gap).toHaveLength(1);
    expect(gap[0].details).toMatchObject({ cause: 'reconciliation_incomplete', runId: r.runId });
    const now = new Date();
    const intervals = deriveUcw(await loadStreamEvents(s.db, s.stream, now), s.stream, now);
    expect(intervals.some(i => i.cause === 'reconciliation_incomplete')).toBe(true);
    expect(coverageStateAt(intervals, new Date((t - 3600) * 1000), now)).toBe('UNCERTIFIED');
  });

  it('T19: an event limit, an invalid page, and a never-ending listing are incomplete too', async () => {
    const t = nowS();
    const evs = [0, 1, 2, 3].map(i => ({ id: evtId(), created: t - 300 * (i + 1) }));
    const a = await run(await setup(), fake(evs), { maxEvents: 2, pageSize: 2 });
    expect(a).toMatchObject({ state: 'incomplete', truncated: { events: true } });
    const b = await run(await setup(), fake(evs, { invalidPage: true }));
    expect(b.state).toBe('incomplete');
    expect(b.errors.map(e => e.code)).toContain('INVALID_PAGE');
    const c = await run(await setup(), fake(evs, { neverEnds: true }), { pageSize: 1, maxPages: 3 });
    expect(c).toMatchObject({ state: 'incomplete', truncated: { pages: true } });
  });

  it('T19: a provider API error is retried with bounded backoff then the run is incomplete; a 4xx is not retried', async () => {
    const f = fake([], { listError: () => new ProviderHttpError(503) });
    const r = await run(await setup(), f, { maxAttempts: 3, backoffMs: 10 });
    expect(r.state).toBe('incomplete');
    expect(f.listCalls).toHaveLength(3);
    expect(f.sleeps).toEqual([10, 20]);
    expect(r.errors[0]).toEqual({ code: 'HTTP_503' });
    const g = fake([], { listError: () => new ProviderHttpError(401) });
    const r2 = await run(await setup(), g, { maxAttempts: 3 });
    expect(r2.state).toBe('incomplete');
    expect(g.listCalls).toHaveLength(1);
  });

  it('T19: an unretrievable or unstorable event makes the run incomplete while the others are still ingested', async () => {
    const s = await setup();
    const t = nowS();
    const good = { id: evtId(), created: t - 300 };
    const notJson = { id: evtId(), created: t - 400, raw: 'not json' };
    const wrongId = { id: evtId(), created: t - 500, raw: raw(evtId(), t - 500) };
    const wrongMode = { id: evtId(), created: t - 600, raw: raw('evt_placeholder', t - 600, { livemode: true }) };
    const gone = { id: evtId(), created: t - 700 };
    const f = fake([good, notJson, wrongId, wrongMode, gone], { retrieveError: id => (id === gone.id ? new ProviderHttpError(404) : null) });
    const r = await run(s, f);
    expect(r.state).toBe('incomplete');
    expect(r.ingested).toBe(1);
    expect(r.errors.map(e => e.code).sort()).toEqual(['RETRIEVE_HTTP_404', 'RETRIEVE_UNSTORABLE', 'RETRIEVE_UNSTORABLE', 'RETRIEVE_UNSTORABLE']);
    expect(f.retrieveCalls.filter(i => i === gone.id)).toHaveLength(1); // 404 not retried
    expect((await rows(`select count(*)::int n from stripe_provider_events where receiving_account_id=$1`, [s.a]))[0].n).toBe(1);
  });

  it('a window older than the retrieval horizon is an unrecovered gap; only the recoverable part is listed', async () => {
    const s = await setup();
    const t = nowS();
    const f = fake([{ id: evtId(), created: t - 3600 }]);
    const start = new Date((t - 40 * 86400) * 1000);
    const r = await run(s, f, { windowStart: start, windowEnd: new Date((t - 60) * 1000), maxWindowSeconds: 90 * 86400 });
    expect(r.state).toBe('unrecovered_gap');
    const horizon = (f.listCalls[0] as { createdGte: number }).createdGte;
    expect(horizon).toBeGreaterThan(Math.floor(start.getTime() / 1000));
    expect(Math.abs(horizon - (t - 29 * 86400))).toBeLessThan(10);
    const gaps = await rows(`select window_start, window_end, details from stripe_evidence_control_events where stream=$1 and event_kind='coverage_gap_unrecovered'`, [s.stream]);
    expect(gaps.some(g => g.details.reason === 'older_than_retrieval_window' && Math.floor(new Date(g.window_end).getTime() / 1000) === horizon)).toBe(true);
  });

  it('refuses before writing anything: attestation not current, invalid window, invalid limits', async () => {
    const noAtt = await setup({ attest: false });
    await expect(run(noAtt, fake([]))).rejects.toMatchObject({ code: 'ATTESTATION_NOT_CURRENT' });
    expect(await rows(`select 1 from stripe_evidence_control_events where stream=$1`, [noAtt.stream])).toHaveLength(0);
    const s = await setup();
    const t = nowS();
    await expect(run(s, fake([]), { windowStart: new Date((t - 60) * 1000), windowEnd: new Date((t - 3600) * 1000) })).rejects.toMatchObject({ code: 'WINDOW_INVALID' });
    await expect(run(s, fake([]), { windowEnd: new Date((t + 3600) * 1000) })).rejects.toMatchObject({ code: 'WINDOW_INVALID' });
    await expect(run(s, fake([]), { windowStart: new Date((t - 10 * 86400) * 1000) })).rejects.toMatchObject({ code: 'WINDOW_INVALID' });
    await expect(run(s, fake([]), { pageSize: 101 })).rejects.toBeInstanceOf(ReconcileError);
    await expect(run(s, fake([]), { maxPages: 0 })).rejects.toMatchObject({ code: 'LIMITS_INVALID' });
    expect(await rows(`select 1 from stripe_evidence_control_events where stream=$1 and event_kind='reconciliation_run'`, [s.stream])).toHaveLength(0);
  });

  it('a dry run lists and compares only: no retrieval, no control events, no evidence', async () => {
    const s = await setup();
    const t = nowS();
    const f = fake([{ id: evtId(), created: t - 300 }, { id: evtId(), created: t - 400 }]);
    const r = await run(s, f, { dryRun: true });
    expect(r).toMatchObject({ state: 'dry_run', listed: 2, absent: 2, ingested: 0 });
    expect(f.retrieveCalls).toEqual([]);
    expect(await rows(`select 1 from stripe_evidence_control_events where stream=$1 and event_kind='reconciliation_run'`, [s.stream])).toHaveLength(0);
    expect(await rows(`select 1 from stripe_provider_events where receiving_account_id=$1`, [s.a])).toHaveLength(0);
  });

  it('T22: rows recovered for an event time inside an uncertified window are flagged, and the window stays uncertified', async () => {
    const s = await setup();
    const t = nowS();
    const slotMs = slotOf((t - 5400) * 1000) * SLOT_SECONDS * 1000;
    const control = new ControlEventWriter(s.db);
    for (let i = 0; i < 3; i++) await control.append({ kind: 'capture_heartbeat', actor: 'test', stream: s.stream, dedupeKey: `hb:${s.stream}:${slotOf(slotMs) + i}`, details: { slot: slotOf(slotMs) + i, mode: 'off', healthy: false } });
    const id = evtId();
    const r = await run(s, fake([{ id, created: t - 3600 }]));
    expect(r.ingested).toBe(1);
    const rec = await rows(`select d.reason_codes from stripe_provider_event_dispositions d join stripe_provider_events e on e.id=d.event_record_id where e.stripe_event_id=$1 and d.disposition='recovered_during_uncertified_window'`, [id]);
    expect(rec).toEqual([{ reason_codes: ['RECONCILIATION'] }]);
    const now = new Date();
    const intervals = deriveUcw(await loadStreamEvents(s.db, s.stream, now), s.stream, now);
    expect(coverageStateAt(intervals, new Date((t - 3600) * 1000), now)).toBe('UNCERTIFIED');
  });

  it('concurrent reconcilers over the same window write one api_retrieval row per event', async () => {
    const a = acct();
    const keyring = await loadKeyring(ring(), new Date());
    const mk = async () => { const db = await newDb(); return { a, db, store: new StripeEvidenceStore(db, { receivingAccountId: a, keyring }), stream: `${a}:false`, keyring, attestationId: null }; };
    const s1 = await mk();
    await rows(`insert into stripe_evidence_control_events(event_kind,actor,stream,details) values ('account_provenance_verified','test',$1,'{"result":"passed"}')`, [s1.stream]);
    const s2 = await mk();
    const t = nowS();
    const evs = [0, 1, 2, 3].map(i => ({ id: evtId(), created: t - 300 * (i + 1) }));
    const [r1, r2] = await Promise.all([run(s1, fake(evs)), run(s2, fake(evs))]);
    expect(r1.errors).toEqual([]);
    expect(r2.errors).toEqual([]);
    // Every event is accounted for exactly once per run: ingested, replayed (lost the race) or already present.
    for (const r of [r1, r2]) expect(r.ingested + r.replayed + r.presentLocally).toBe(4);
    expect((await rows(`select count(*)::int n from stripe_provider_events where receiving_account_id=$1 and provenance='api_retrieval'`, [a]))[0].n).toBe(4);
  });

  it('a second retrieval with different bytes is a recorded provider_field_mismatch conflict, once; the first row is untouched', async () => {
    const s = await setup();
    const t = nowS();
    const id = evtId();
    const cap = (body: string) => {
      const sh = classifyEnvelope(body);
      if (sh.kind !== 'ok') throw new Error('fixture');
      return s.store.captureRetrieved({ rawBody: new TextEncoder().encode(body), envelope: sh.envelope, retrievedAt: new Date(), retrievalRunId: s.attestationId!, retrievalApiVersion: 'v', receivedAt: new Date(), attestationEventId: s.attestationId!, retention: RETENTION });
    };
    const first = await cap(raw(id, t - 100));
    expect(first.outcome).toBe('captured');
    expect((await cap(raw(id, t - 100))).outcome).toBe('replay');
    const changed = raw(id, t - 100, { pending_webhooks: 2 });
    const c1 = await cap(changed);
    const c2 = await cap(changed);
    expect(c1).toMatchObject({ outcome: 'conflict', conflictRecorded: true });
    expect(c2).toMatchObject({ outcome: 'conflict', conflictRecorded: false });
    const conflicts = await rows(`select conflict_kind, conflicting_provenance, retrieval_run_id, sig_scheme from stripe_provider_event_conflicts where event_record_id=$1`, [first.eventRecordId]);
    expect(conflicts).toEqual([{ conflict_kind: 'provider_field_mismatch', conflicting_provenance: 'api_retrieval', retrieval_run_id: s.attestationId, sig_scheme: null }]);
    expect((await rows(`select count(*)::int n from stripe_provider_event_dispositions where event_record_id=$1 and disposition='quarantined' and 'QR_PROVIDER_FIELD_MISMATCH'=any(reason_codes)`, [first.eventRecordId]))[0].n).toBe(1);
  });

  describe('stripeFetchSource (fake fetch; the real provider is not contacted)', () => {
    const resp = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });
    it('builds the bounded list request, parses pages, and keeps retrieve bytes exact', async () => {
      const calls: { url: string; auth: string | null }[] = [];
      const exact = '{"id":"evt_x",  "spacing":"preserved"}\n';
      const src = stripeFetchSource('rk_test_SECRETKEY', (async (url: string, init?: RequestInit) => {
        calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return url.includes('/v1/events/evt_x') ? resp(exact, 200, { 'stripe-version': '2026-05-27.dahlia' }) : resp(JSON.stringify({ object: 'list', data: [{ id: 'evt_x', type: 't', created: 5, extra: 1 }], has_more: true }));
      }) as never);
      const page = await src.list({ createdGte: 10, createdLt: 20, types: ['a.b', 'c.d'], limit: 50, startingAfter: 'evt_prev' });
      expect(page).toEqual({ events: [{ id: 'evt_x', type: 't', created: 5 }], hasMore: true });
      const u = new URL(calls[0]!.url);
      expect(u.searchParams.get('created[gte]')).toBe('10');
      expect(u.searchParams.get('created[lt]')).toBe('20');
      expect(u.searchParams.get('limit')).toBe('50');
      expect(u.searchParams.get('starting_after')).toBe('evt_prev');
      expect(u.searchParams.getAll('types[]')).toEqual(['a.b', 'c.d']);
      expect(calls[0]!.auth).toBe('Bearer rk_test_SECRETKEY');
      expect(await src.retrieve('evt_x')).toEqual({ rawBody: exact, apiVersion: '2026-05-27.dahlia' });
    });
    it('maps HTTP failures and malformed pages to typed errors that never contain the key', async () => {
      const bad = stripeFetchSource('rk_test_SECRETKEY', (async () => resp('{"error":{"message":"bad rk_test_SECRETKEY"}}', 401)) as never);
      const err = await bad.list({ createdGte: 1, createdLt: 2, limit: 1 }).catch(e => e as Error);
      expect(err).toBeInstanceOf(ProviderHttpError);
      expect((err as ProviderHttpError).status).toBe(401);
      expect(String((err as Error).message)).not.toContain('rk_test');
      const odd = stripeFetchSource('rk_test_K', (async () => resp('{"object":"nope"}')) as never);
      await expect(odd.list({ createdGte: 1, createdLt: 2, limit: 1 })).rejects.toBeInstanceOf(InvalidProviderPage);
    });
  });
});
