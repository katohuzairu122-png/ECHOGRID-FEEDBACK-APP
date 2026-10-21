import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { buildDb, type Database } from '../../src/db/client';
import {
  cohortOf, writeHeartbeat, recordModeChange, materializeUcw, loadStreamEvents, deriveUcw, evaluateWatchdog, coverageStateAt, coverageReport,
  heartbeatKey, SLOT_SECONDS, slotOf, type CaptureEnv,
} from '../../src/billing/stripe-evidence';

/**
 * HETA-01-F1 heartbeat writer, mode-change recording, UCW materialization and the watchdog evaluation against a
 * DISPOSABLE PostgreSQL (T20, T21, T22, T23, T43 persistence parts). Control events are append-only; accounts are
 * random per test so reruns do not collide.
 */
const monthsFrom = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const testKek = (cohort: string) => createHash('sha256').update(`heta01-f1-test-kek:${cohort}`).digest().toString('base64');
const ring = () => JSON.stringify({ v: 1, keys: [0, 1, 2].map(n => { const s = monthsFrom(new Date(), n); return { cohort: cohortOf(s), kek_version: 'v1', alg: 'AES-256-GCM', key: testKek(cohortOf(s)), not_before: s.toISOString(), not_after: '2100-01-01T00:00:00Z', active: true }; }) });

describe.skipIf(!process.env.DATABASE_URL)('heartbeat, UCW materialization and watchdog (integration, disposable database)', () => {
  const clients: Client[] = [];
  let q: Client;
  const rows = async (t: string, p: unknown[] = []) => (await q.query(t, p)).rows;
  const newDb = async (): Promise<Database> => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    clients.push(c);
    return buildDb(c);
  };
  beforeAll(async () => { q = new Client({ connectionString: process.env.DATABASE_URL }); await q.connect(); });
  afterAll(async () => { await q.end(); await Promise.all(clients.map(c => c.end().catch(() => undefined))); });

  const acct = () => `acct_B${randomBytes(6).toString('hex')}`;
  const envFor = (a: string, over: Partial<CaptureEnv> = {}): CaptureEnv => ({
    STRIPE_EVIDENCE_CAPTURE: 'enforced', STRIPE_ACCOUNT_ID: a, STRIPE_EXPECTED_LIVEMODE: 'false', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    EVIDENCE_KEK_KEYRING: ring(), EVIDENCE_RETENTION_POLICY_VERSION: 'test-v1', EVIDENCE_RETENTION_DAYS: '365', EVIDENCE_L2_MAX_AGE_SECONDS: '86400', EVIDENCE_DB_ROLE_RISK_ACK: 'owner-role-risk-accepted', ...over,
  });
  const attest = async (a: string) => (await rows(`insert into stripe_evidence_control_events(event_kind,actor,stream,details) values ('account_provenance_verified','test',$1,'{"result":"passed"}') returning id`, [`${a}:false`]))[0].id;
  // A deterministic timeline in the recent past so history windows and the retained-heartbeat logic apply.
  const T0 = new Date(Date.now() - 6 * 3600_000);
  const slotAt = (i: number) => slotOf(T0.getTime()) + i;
  const msAt = (i: number) => slotAt(i) * SLOT_SECONDS * 1000;

  it('T20: concurrent isolates in one slot write exactly one heartbeat (slot-based dedupe key)', async () => {
    const a = acct();
    await attest(a);
    const dbs = await Promise.all(Array.from({ length: 12 }, newDb));
    const env = envFor(a);
    const results = await Promise.all(dbs.map(db => writeHeartbeat(db, env, msAt(0) + 1234, new Date(msAt(0) + 2000))));
    expect(results.filter(r => r.inserted)).toHaveLength(1);
    const hb = await rows(`select dedupe_key, details from stripe_evidence_control_events where stream=$1 and event_kind='capture_heartbeat'`, [`${a}:false`]);
    expect(hb).toHaveLength(1);
    expect(hb[0].dedupe_key).toBe(heartbeatKey(`${a}:false`, slotAt(0)));
    expect(hb[0].details).toMatchObject({ slot: slotAt(0), mode: 'enforced', healthy: true, runwayCohorts: 2 });
    expect(JSON.stringify(hb[0].details)).not.toContain('whsec_');
  });

  it('T20: the heartbeat truthfully reports unhealthy preconditions (no attestation, bad retention, invalid mode)', async () => {
    const a = acct();
    const db = await newDb();
    const noAtt = await writeHeartbeat(db, envFor(a), msAt(1), new Date(msAt(1)));
    expect(noAtt.healthy).toBe(false);
    const retention = await writeHeartbeat(db, envFor(a, { EVIDENCE_RETENTION_POLICY_VERSION: undefined }), msAt(2), new Date(msAt(2)));
    expect(retention.healthy).toBe(false);
    await writeHeartbeat(db, envFor(a, { STRIPE_EVIDENCE_CAPTURE: 'ENFORCED' }), msAt(3), new Date(msAt(3)));
    const rs = await rows(`select details from stripe_evidence_control_events where stream=$1 and event_kind='capture_heartbeat' order by seq`, [`${a}:false`]);
    expect(rs[0].details.checks.attestationCurrent).toBe(false);
    expect(rs[1].details.configFailures).toContain('RETENTION_UNAPPROVED');
    expect(rs[2].details).toMatchObject({ mode: 'invalid', healthy: false });
  });

  it('T20/T43: a simulated gap yields exactly one heartbeat_gap_detected and ucw_opened from concurrent detectors, with deterministic keys; recovery closes after K', async () => {
    const a = acct();
    const stream = `${a}:false`;
    await attest(a);
    const db = await newDb();
    const env = envFor(a);
    await recordModeChange(db, { stream, from: 'off', to: 'enforced', effectiveAt: new Date(msAt(0) - 1000), actor: 'test', commitSha: 'abc123', approvalRef: 'TEST-1' });
    for (let i = 0; i <= 10; i++) await writeHeartbeat(db, env, msAt(i), new Date(msAt(i) + 1000));
    // outage: slots 11..19 missing; resume at 20
    await writeHeartbeat(db, env, msAt(20), new Date(msAt(20) + 1000));
    const now = new Date(msAt(20) + 2000);
    const detectors = await Promise.all(Array.from({ length: 8 }, async () => materializeUcw(await newDb(), stream, now)));
    expect(detectors.reduce((n, r) => n + r.inserted, 0)).toBe(detectors[0]!.planned); // each key written exactly once across detectors
    const gap = await rows(`select dedupe_key, cause, window_start from stripe_evidence_control_events where stream=$1 and event_kind='heartbeat_gap_detected'`, [stream]);
    const opened = await rows(`select dedupe_key, cause from stripe_evidence_control_events where stream=$1 and event_kind='ucw_opened' and cause='heartbeat_gap'`, [stream]);
    expect(gap).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(new Date(gap[0].window_start).getTime()).toBe(msAt(10)); // last good slot
    // repeated resume: no new rows
    expect((await materializeUcw(db, stream, now)).inserted).toBe(0);
    // recovery: 2 more healthy -> K=3 healthy from resume closes at the 3rd (slot 22)
    for (const i of [21, 22]) await writeHeartbeat(db, env, msAt(i), new Date(msAt(i) + 1000));
    const later = new Date(msAt(22) + 2000);
    await materializeUcw(db, stream, later);
    const closed = await rows(`select window_start, window_end from stripe_evidence_control_events where stream=$1 and event_kind='ucw_closed' and cause='heartbeat_gap'`, [stream]);
    expect(closed).toHaveLength(1);
    expect(new Date(closed[0].window_end).getTime()).toBe(msAt(22));
    // the interval stays uncertified forever; the report says unknown
    const intervals = deriveUcw(await loadStreamEvents(db, stream, later), stream, later);
    expect(coverageStateAt(intervals, new Date(msAt(15)), later)).toBe('UNCERTIFIED');
    expect(coverageReport(stream, intervals, later).eventsMissedDuringUncertifiedWindows).toBe('unknown');
  });

  it('a gap that began before the retained history window is still detected (older heartbeat is loaded)', async () => {
    const a = acct();
    const stream = `${a}:false`;
    await attest(a);
    const db = await newDb();
    const env = envFor(a);
    const old = Date.now() - 20 * 86_400_000;
    await recordModeChange(db, { stream, from: 'off', to: 'enforced', effectiveAt: new Date(old - 1000), actor: 'test' });
    for (let i = 0; i < 5; i++) await writeHeartbeat(db, env, old + i * 300_000, new Date(old + i * 300_000));
    await writeHeartbeat(db, env, Date.now() - 60_000, new Date()); // resumes 20 days later
    const out = await materializeUcw(db, stream, new Date());
    expect(out.planned).toBeGreaterThan(0);
    expect((await rows(`select 1 from stripe_evidence_control_events where stream=$1 and event_kind='heartbeat_gap_detected'`, [stream])).length).toBe(1);
  });

  it('T23: each mode change is appended with actor, commit and approval, and a repeat of the same change is a no-op', async () => {
    const a = acct();
    const stream = `${a}:false`;
    const db = await newDb();
    const at = new Date(msAt(0));
    expect(await recordModeChange(db, { stream, from: 'off', to: 'enforced', effectiveAt: at, actor: 'deploy', commitSha: 'deadbeef', approvalRef: 'CHG-9' })).toBe(true);
    expect(await recordModeChange(db, { stream, from: 'off', to: 'enforced', effectiveAt: at, actor: 'deploy', commitSha: 'deadbeef', approvalRef: 'CHG-9' })).toBe(false);
    expect(await recordModeChange(db, { stream, from: 'enforced', to: 'off', effectiveAt: new Date(msAt(5)), actor: 'deploy' })).toBe(true);
    const r = await rows(`select actor, commit_sha, approval_ref, details from stripe_evidence_control_events where stream=$1 and event_kind='capture_mode_changed' order by seq`, [stream]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ actor: 'deploy', commit_sha: 'deadbeef', approval_ref: 'CHG-9', details: { from: 'off', to: 'enforced' } });
  });

  it('T22: capture off opens a capture_off UCW from the first off heartbeat; materialized once; report says unknown', async () => {
    const a = acct();
    const stream = `${a}:false`;
    const db = await newDb();
    const env = envFor(a, { STRIPE_EVIDENCE_CAPTURE: 'off' });
    for (let i = 0; i < 4; i++) await writeHeartbeat(db, env, msAt(i), new Date(msAt(i) + 500));
    const now = new Date(msAt(3) + 1000);
    await materializeUcw(db, stream, now);
    await materializeUcw(db, stream, now);
    const opened = await rows(`select window_start from stripe_evidence_control_events where stream=$1 and event_kind='ucw_opened' and cause='capture_off'`, [stream]);
    expect(opened).toHaveLength(1);
    expect(new Date(opened[0].window_start).getTime()).toBe(msAt(0));
    const intervals = deriveUcw(await loadStreamEvents(db, stream, now), stream, now);
    const rep = coverageReport(stream, intervals, now);
    expect(rep.state).toBe('UNCERTIFIED');
    expect(rep.eventsMissedDuringUncertifiedWindows).toBe('unknown');
  });

  it('T21: the watchdog evaluation over persisted events flags a stale heartbeat and an open UCW without the Worker', async () => {
    const a = acct();
    const stream = `${a}:false`;
    await attest(a);
    const db = await newDb();
    const env = envFor(a);
    await recordModeChange(db, { stream, from: 'off', to: 'enforced', effectiveAt: new Date(msAt(0) - 1000), actor: 'test' });
    for (let i = 0; i <= 6; i++) await writeHeartbeat(db, env, msAt(i), new Date(msAt(i) + 500));
    const healthyNow = new Date(msAt(6) + 60_000);
    const ok = evaluateWatchdog(await loadStreamEvents(db, stream, healthyNow), stream, healthyNow).map(x => x.code);
    expect(ok).not.toContain('HEARTBEAT_STALE');
    expect(ok).not.toContain('UCW_OPEN');
    const stale = new Date(msAt(6) + 45 * 60_000);
    const codes = evaluateWatchdog(await loadStreamEvents(db, stream, stale), stream, stale).map(x => x.code);
    expect(codes).toEqual(expect.arrayContaining(['HEARTBEAT_STALE', 'UCW_OPEN']));
  });
});
