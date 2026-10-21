import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import Stripe from 'stripe';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { cohortOf, handleEnforcedCapture, isCaptureOff, type CaptureEnv, type HandlerResult } from '../../src/billing/stripe-evidence';

/**
 * HETA-01-F1 IMPL-1 capture handler (Class P/S/E, buckets, full path) against a DISPOSABLE PostgreSQL.
 * Evidence tables are append-only; rows persist. Accounts and event ids are random per run.
 */
const SECRET = 'whsec_handler_primary';
const monthsFrom = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const testKek = (cohort: string) => createHash('sha256').update(`heta01-f1-test-kek:${cohort}`).digest().toString('base64');
const ring = () =>
  JSON.stringify({ v: 1, keys: [0, 1, 2].map(n => { const s = monthsFrom(new Date(), n); return { cohort: cohortOf(s), kek_version: 'v1', alg: 'AES-256-GCM', key: testKek(cohortOf(s)), not_before: s.toISOString(), not_after: '2100-01-01T00:00:00Z', active: true }; }) });

describe.skipIf(!process.env.DATABASE_URL)('stripe evidence capture handler (integration, disposable database)', () => {
  const clients: Client[] = [];
  let q: Client;
  const rows = async (text: string, params: unknown[] = []) => (await q.query(text, params)).rows;
  const openDb = async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    clients.push(c);
    return { db: buildDb(c), close: async () => { await c.end().catch(() => undefined); } };
  };
  beforeAll(async () => {
    q = new Client({ connectionString: process.env.DATABASE_URL });
    await q.connect();
  });
  afterAll(async () => {
    await q.end();
    await Promise.all(clients.map(c => c.end().catch(() => undefined)));
  });

  const acct = () => `acct_H${randomBytes(6).toString('hex')}`;
  const evtId = () => `evt_h${randomBytes(8).toString('hex')}`;
  const baseEnv = (a: string): CaptureEnv => ({
    STRIPE_EVIDENCE_CAPTURE: 'enforced', STRIPE_ACCOUNT_ID: a, STRIPE_EXPECTED_LIVEMODE: 'false', STRIPE_WEBHOOK_SECRET: SECRET,
    EVIDENCE_KEK_KEYRING: ring(), EVIDENCE_RETENTION_POLICY_VERSION: 'test-v1', EVIDENCE_RETENTION_DAYS: '365',
  });
  const attest = async (a: string, result = 'passed', ageSeconds = 0) =>
    (await rows(`insert into stripe_evidence_control_events(event_kind,actor,stream,details,occurred_at) values ('account_provenance_verified','test',$1,$2::jsonb, clock_timestamp() - make_interval(secs => $3)) returning id`, [`${a}:false`, JSON.stringify({ result }), ageSeconds]))[0].id as string;
  const body = (id: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ id, type: 'customer.subscription.updated', created: 1700000000, livemode: false, data: { object: { id: 'sub_h1', object: 'subscription', customer: 'cus_h1' } }, ...over });
  const sign = (b: string, secret = SECRET) => Stripe.webhooks.generateTestHeaderStringAsync({ payload: b, secret, timestamp: Math.floor(Date.now() / 1000), cryptoProvider: Stripe.createSubtleCryptoProvider() });

  type Opts = { env?: CaptureEnv; header?: string | null; openDb?: typeof openDb; legacy?: (e: Stripe.Event) => Promise<void>; contentLength?: number | null };
  const call = async (a: string, b: string, o: Opts = {}) => {
    const legacy = vi.fn(o.legacy ?? (async () => undefined));
    const open = vi.fn(o.openDb ?? openDb);
    const header = o.header === undefined ? await sign(b) : o.header;
    const run = () => handleEnforcedCapture({ rawBody: b, signatureHeader: header, contentLength: o.contentLength ?? null, env: o.env ?? baseEnv(a), openDb: open, runLegacy: async (e) => legacy(e) });
    return { run, legacy, open };
  };
  const exec = async (a: string, b: string, o: Opts = {}) => {
    const c = await call(a, b, o);
    return { result: await c.run(), legacy: c.legacy, open: c.open };
  };
  const inbox = async (a: string) => (await rows('select count(*)::int n from stripe_provider_events where receiving_account_id=$1', [a]))[0].n as number;
  const buckets = async (a: string, kind: string) => rows(`select details from stripe_evidence_control_events where stream=$1 and event_kind=$2`, [`${a}:false`, kind]);

  it('E.1: unset, empty and off keep today\'s behavior; any other value takes the evidence path (and fails closed there)', () => {
    for (const v of [undefined, '', 'off']) expect(isCaptureOff({ STRIPE_EVIDENCE_CAPTURE: v })).toBe(true);
    for (const v of ['enforced', 'ENFORCED', 'on', 'shadow']) expect(isCaptureOff({ STRIPE_EVIDENCE_CAPTURE: v })).toBe(false);
  });

  it('Class P: missing or invalid signature is 400 and opens no database connection', async () => {
    const a = acct();
    await attest(a);
    const b = body(evtId());
    for (const header of [null, 'garbage', await sign(b, 'whsec_wrong')]) {
      const r = await exec(a, b, { header });
      expect(r.result.status).toBe(400);
      expect(r.open).not.toHaveBeenCalled();
      expect(r.legacy).not.toHaveBeenCalled();
    }
    expect(await inbox(a)).toBe(0);
  });

  it('Class P: oversize is 413 before authentication, stores no payload, and buckets once per minute', async () => {
    const a = acct();
    const env = { ...baseEnv(a), EVIDENCE_MAX_BODY_BYTES: '200' };
    const big = body(evtId(), { pad: 'x'.repeat(500) });
    const r1 = await exec(a, big, { env, header: 'garbage' });
    const r2 = await exec(a, big, { env, header: await sign(big) });
    const r3 = await exec(a, '', { env, header: null, contentLength: 5000 });
    for (const r of [r1, r2, r3]) { expect(r.result.status).toBe(413); expect(r.legacy).not.toHaveBeenCalled(); }
    expect(await inbox(a)).toBe(0);
    const b = await buckets(a, 'oversize_rejected');
    expect(b.length).toBe(1); // same minute, deterministic dedupe key
    expect(JSON.stringify(b[0].details)).not.toContain('xxxxx'); // no payload content in the bucket
  });

  it.each([
    ['projection mode other than legacy', (e: CaptureEnv) => ({ ...e, STRIPE_PROJECTION_MODE: 'f3_experimental' }), 'PROJECTION_MODE_NOT_LEGACY'],
    ['account id unset', (e: CaptureEnv) => ({ ...e, STRIPE_ACCOUNT_ID: undefined }), 'ACCOUNT_ID_INVALID'],
    ['account id malformed', (e: CaptureEnv) => ({ ...e, STRIPE_ACCOUNT_ID: 'not-an-account' }), 'ACCOUNT_ID_INVALID'],
    ['expected livemode unset', (e: CaptureEnv) => ({ ...e, STRIPE_EXPECTED_LIVEMODE: undefined }), 'LIVEMODE_UNSET'],
    ['retention policy unapproved', (e: CaptureEnv) => ({ ...e, EVIDENCE_RETENTION_POLICY_VERSION: undefined }), 'RETENTION_UNAPPROVED'],
    ['retention days invalid', (e: CaptureEnv) => ({ ...e, EVIDENCE_RETENTION_DAYS: '0' }), 'RETENTION_UNAPPROVED'],
    ['keyring missing', (e: CaptureEnv) => ({ ...e, EVIDENCE_KEK_KEYRING: undefined }), 'KEYRING_INVALID'],
    ['keyring without runway', (e: CaptureEnv) => ({ ...e, EVIDENCE_KEK_KEYRING: JSON.stringify({ v: 1, keys: [JSON.parse(ring()).keys[0]] }) }), 'KEYRING_INVALID'],
    ['invalid capture mode value', (e: CaptureEnv) => ({ ...e, STRIPE_EVIDENCE_CAPTURE: 'ENFORCED' }), 'CAPTURE_MODE_INVALID'],
    ['invalid lease', (e: CaptureEnv) => ({ ...e, EVIDENCE_LEASE_SECONDS: '1' }), 'LIMITS_INVALID'],
  ])('Class S: %s -> 503, nothing stored, code-only bucket', async (_n, mutate, code) => {
    const a = acct();
    await attest(a);
    const env = mutate(baseEnv(a));
    const b = body(evtId());
    const r = await exec(a, b, { env });
    expect(r.result).toEqual({ status: 503, body: { error: 'CAPTURE_PRECONDITION_FAILED' } });
    expect(r.legacy).not.toHaveBeenCalled();
    const stream = env.STRIPE_ACCOUNT_ID && /^acct_/.test(env.STRIPE_ACCOUNT_ID) ? a : 'unconfigured';
    const bs = await rows(`select details from stripe_evidence_control_events where event_kind='capture_precondition_failed' and stream like $1 order by seq desc limit 1`, [`${stream}:%`]);
    expect(JSON.stringify(bs[0]?.details ?? {})).toContain(code);
    expect(JSON.stringify(bs[0]?.details ?? {})).not.toContain(SECRET);
    if (env.STRIPE_ACCOUNT_ID === a) expect(await inbox(a)).toBe(0);
  });

  it('Class S: attestation missing, failed or stale -> 503 and nothing stored; a fresh pass restores capture', async () => {
    const a = acct();
    const b = body(evtId());
    expect((await exec(a, b)).result.status).toBe(503); // none yet
    await attest(a, 'passed', 90_000); // older than the 24h default
    expect((await exec(a, b)).result.status).toBe(503);
    await attest(a, 'passed');
    expect((await exec(a, b)).result.status).toBe(200);
    await attest(a, 'failed'); // a later failure supersedes the earlier pass
    expect((await exec(a, body(evtId()))).result.status).toBe(503);
    expect(await inbox(a)).toBe(1);
    expect((await buckets(a, 'capture_precondition_failed')).length).toBeGreaterThan(0);
  });

  it('Class S: database unreachable -> 503', async () => {
    const a = acct();
    const r = await exec(a, body(evtId()), { openDb: async () => { throw new Error('connect ECONNREFUSED'); } });
    expect(r.result.status).toBe(503);
    expect(r.legacy).not.toHaveBeenCalled();
  });

  it('full path: captures, claims, annotates, runs legacy once, records the completion marker; replay is complete and does not re-run', async () => {
    const a = acct();
    await attest(a);
    const id = evtId();
    const b = body(id);
    const first = await exec(a, b);
    expect(first.result).toEqual({ status: 200, body: { received: true, capture: 'processed' } });
    expect(first.legacy).toHaveBeenCalledTimes(1);
    expect(first.legacy.mock.calls[0]![0]).toMatchObject({ id, type: 'customer.subscription.updated' });
    const ev = (await rows('select id from stripe_provider_events where receiving_account_id=$1', [a]))[0].id;
    expect((await rows('select disposition from stripe_provider_event_dispositions where event_record_id=$1 order by seq', [ev])).map(r => r.disposition))
      .toEqual(['capture_committed', 'processing_claimed', 'eligible_for_projection', 'projection_applied']);
    const second = await exec(a, b);
    expect(second.result).toEqual({ status: 200, body: { received: true, capture: 'complete' } });
    expect(second.legacy).not.toHaveBeenCalled();
    expect(await inbox(a)).toBe(1);
  });

  it('H20/G.5: mode mismatch, Connect scope and out-of-scope types are annotated, and legacy STILL runs (no behavior change)', async () => {
    const a = acct();
    await attest(a);
    const mm = await exec(a, body(evtId(), { livemode: true }));
    const cn = await exec(a, body(evtId(), { account: 'acct_OTHER' }));
    const oos = await exec(a, body(evtId(), { type: 'invoice.paid' }));
    for (const r of [mm, cn, oos]) { expect(r.result.status).toBe(200); expect(r.legacy).toHaveBeenCalledTimes(1); }
    const reasons = async (id: string) => rows(`select disposition, reason_codes from stripe_provider_event_dispositions d join stripe_provider_events e on e.id=d.event_record_id where e.stripe_event_id=$1 and d.disposition in ('quarantined','out_of_scope_type','eligible_for_projection','projection_applied','projection_skipped') order by d.seq`, [id]);
    const byEvent = async (r: typeof mm) => reasons((r.legacy.mock.calls[0]![0] as Stripe.Event).id);
    expect((await byEvent(mm)).map(r => [r.disposition, r.reason_codes])).toEqual([['quarantined', ['QR_MODE_MISMATCH']], ['projection_applied', []]]);
    expect((await byEvent(cn)).map(r => [r.disposition, r.reason_codes])).toEqual([['quarantined', ['QR_CONNECT_UNSUPPORTED']], ['projection_applied', []]]);
    expect((await byEvent(oos)).map(r => [r.disposition, r.reason_codes])).toEqual([['out_of_scope_type', ['QR_TYPE_UNSUPPORTED']], ['projection_skipped', []]]);
  });

  it('Class E: a signed body that is not a valid envelope is 200, captured as a receipt, never processed', async () => {
    const a = acct();
    await attest(a);
    for (const b of [`not json ${a}`, `[1,"${a}"]`, JSON.stringify({ hello: a })]) {
      const r = await exec(a, b);
      expect(r.result).toEqual({ status: 200, body: { received: true, capture: 'malformed' } });
      expect(r.legacy).not.toHaveBeenCalled();
    }
    expect(await inbox(a)).toBe(0);
    expect((await rows(`select count(*)::int n from stripe_provider_malformed_receipts where receiving_account_id=$1`, [a]))[0].n).toBe(3);
  });

  it('conflict: same event id with a different body is 200 conflict and is not processed', async () => {
    const a = acct();
    await attest(a);
    const id = evtId();
    await exec(a, body(id));
    const r = await exec(a, body(id, { data: { object: { id: 'sub_other', object: 'subscription' } } }));
    expect(r.result).toEqual({ status: 200, body: { received: true, capture: 'conflict' } });
    expect(r.legacy).not.toHaveBeenCalled();
  });

  it('G.3: a legacy failure records projection_failed and rethrows (today\'s 500); the redelivery is attempt 2 and completes', async () => {
    const a = acct();
    await attest(a);
    const b = body(evtId());
    const failing = await call(a, b, { legacy: async () => { throw new Error('legacy boom'); } });
    await expect(failing.run()).rejects.toThrow('legacy boom');
    const ev = (await rows('select id from stripe_provider_events where receiving_account_id=$1', [a]))[0].id;
    expect((await rows('select disposition, attempt_no from stripe_provider_event_dispositions where event_record_id=$1 and attempt_no is not null order by seq', [ev])).map(r => [r.disposition, r.attempt_no]))
      .toEqual([['processing_claimed', 1], ['projection_failed', 1]]);
    expect((await buckets(a, 'capture_error_observed')).length).toBe(1);
    const retry = await exec(a, b);
    expect(retry.result).toEqual({ status: 200, body: { received: true, capture: 'processed' } });
    expect(retry.legacy).toHaveBeenCalledTimes(1);
    expect((await exec(a, b)).result).toEqual({ status: 200, body: { received: true, capture: 'complete' } });
  });

  it('T06: 10 concurrent identical deliveries: one inbox row, legacy runs exactly once, the rest get 409 or complete', async () => {
    const a = acct();
    await attest(a);
    const b = body(evtId());
    const header = await sign(b);
    let ran = 0;
    const slow = async () => { ran++; await new Promise(r => setTimeout(r, 400)); };
    const results = await Promise.all(Array.from({ length: 10 }, async () => {
      const c = await call(a, b, { header, legacy: slow });
      return c.run();
    }));
    expect(ran).toBe(1);
    const statuses = results.map((r: HandlerResult) => r.status);
    expect(statuses.filter(s => s === 200)).toHaveLength(1);
    expect(statuses.filter(s => s === 409)).toHaveLength(9);
    expect(await inbox(a)).toBe(1);
  });

  it('F1 invariant: no evidence module reads configuration or the database to set the three authority flags', () => {
    const dir = resolve(__dirname, '../../src/billing/stripe-evidence');
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(resolve(dir, f), 'utf8');
      for (const flag of ['historicalTierVerified', 'issuanceAuthorized', 'redemptionAuthorized']) expect(src, `${f} mentions ${flag}`).not.toContain(flag);
    }
  });
});
