import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import {
  StripeEvidenceStore, ForensicReader, loadKeyring, classifyEnvelope, cohortOf, EvidenceStoreError, type LoadedKeyring, type WellFormedCapture, type MalformedCapture,
} from '../../src/billing/stripe-evidence';

/**
 * HETA-01-F1 IMPL-1 capture and claim logic against a real, DISPOSABLE PostgreSQL (T01-T12, T38, T39, T35 parts).
 * The evidence tables are append-only, so rows written here cannot be cleaned up; never point DATABASE_URL at
 * a shared or production database. Event ids and bodies are random per run, so reruns do not collide.
 */
const RECEIVING = 'acct_TESTRECEIVING';
const SIG = { headerTimestamp: 1700000001, scheme: 'v1' as const, secretLabel: 'primary', verifiedAt: new Date(), verifierVersion: 'test' };
const RETENTION = { policyVersion: 'test-v1', retainUntil: new Date(Date.now() + 365 * 86400000) };

const monthsFrom = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
// Deterministic per cohort so reruns against the same (append-only, uncleanable) database can still unwrap earlier DEKs.
const testKek = (cohort: string) => createHash('sha256').update(`heta01-f1-test-kek:${cohort}`).digest().toString('base64');
const ringFor = (now: Date) =>
  JSON.stringify({
    v: 1,
    keys: [0, 1, 2].map(n => {
      const start = monthsFrom(now, n);
      return {
        cohort: cohortOf(start), kek_version: 'v1', alg: 'AES-256-GCM', key: testKek(cohortOf(start)),
        not_before: start.toISOString(), not_after: '2100-01-01T00:00:00Z', active: true,
      };
    }),
  });

describe.skipIf(!process.env.DATABASE_URL)('stripe evidence store (integration, disposable database)', () => {
  const clients: Client[] = [];
  let keyring: LoadedKeyring;
  let attestationId: string;
  let main: StripeEvidenceStore;

  const newStore = async (kr = keyring, now?: () => Date) => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    clients.push(c);
    return new StripeEvidenceStore(buildDb(c), { receivingAccountId: RECEIVING, keyring: kr, now });
  };
  const CTX = { actor: 'test', reason: 'integration test' };
  const readerFor = async (kr = keyring) => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    clients.push(c);
    return new ForensicReader(buildDb(c), kr);
  };
  const sql = async (text: string, params: unknown[] = []) => (await clients[0]!.query(text, params)).rows;

  const eventBody = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, type: 'customer.subscription.updated', created: 1700000000, livemode: false, api_version: '2026-05-27.dahlia', request: { id: 'req_1', idempotency_key: null },
      data: { object: { id: 'sub_123', object: 'subscription', customer: 'cus_123' } }, ...extra });
  const wellFormed = (body: string): WellFormedCapture => {
    const r = classifyEnvelope(body);
    if (r.kind !== 'ok') throw new Error('fixture must be well formed');
    return { rawBody: new TextEncoder().encode(body), envelope: r.envelope, signature: SIG, receivedAt: new Date(), attestationEventId: attestationId, retention: RETENTION };
  };
  const malformed = (body: string): MalformedCapture => {
    const r = classifyEnvelope(body);
    if (r.kind !== 'malformed') throw new Error('fixture must be malformed');
    return { rawBody: new TextEncoder().encode(body), parseStatus: r.parseStatus, defects: r.defects, signature: SIG, receivedAt: new Date(), attestationEventId: attestationId, retention: RETENTION };
  };
  const evtId = () => `evt_t${randomBytes(8).toString('hex')}`;
  const dispositions = async (id: string) => (await sql('select disposition, attempt_no from stripe_provider_event_dispositions where event_record_id=$1 order by seq', [id])) as { disposition: string; attempt_no: number | null }[];

  beforeAll(async () => {
    keyring = await loadKeyring(ringFor(new Date()), new Date());
    main = await newStore();
    attestationId = (await sql(`insert into stripe_evidence_control_events(event_kind,actor,details) values ('account_provenance_verified','test','{"result":"passed"}') returning id`))[0].id;
  });
  afterAll(async () => {
    await Promise.all(clients.map(c => c.end()));
  });

  it('T01: captures a well-formed event encrypted; plaintext round-trips; advisory claims extracted; no attribution', async () => {
    const body = eventBody(evtId());
    const r = await main.captureWellFormed(wellFormed(body));
    expect(r.outcome).toBe('captured');
    expect(new TextDecoder().decode(await (await readerFor()).readEvent(r.eventRecordId, CTX))).toBe(body);
    const row = (await sql('select * from stripe_provider_events where id=$1', [r.eventRecordId]))[0];
    expect(row).toMatchObject({ account_scope: 'direct', provenance: 'webhook_signature', stripe_subscription_id: 'sub_123', stripe_customer_id: 'cus_123', capture_mode: 'enforced', projection_mode: 'legacy' });
    expect(Buffer.from(row.payload_ciphertext).includes(Buffer.from('sub_123'))).toBe(false); // ciphertext, not plaintext
    expect((await dispositions(r.eventRecordId)).map(d => d.disposition)).toEqual(['capture_committed']);
    expect((await sql('select business_id from stripe_provider_event_dispositions where event_record_id=$1', [r.eventRecordId])).every(d => d.business_id === null)).toBe(true);
  });

  it('T03: an identical redelivery is an idempotent replay (one row)', async () => {
    const body = eventBody(evtId());
    const a = await main.captureWellFormed(wellFormed(body));
    const b = await main.captureWellFormed(wellFormed(body));
    expect(b).toEqual({ outcome: 'replay', eventRecordId: (a as { eventRecordId: string }).eventRecordId });
    expect((await sql('select count(*)::int n from stripe_provider_events where stripe_event_id=$1', [JSON.parse(body).id]))[0].n).toBe(1);
  });

  it('T05: the same event id with a different body records a sealed conflict and a quarantine, once', async () => {
    const id = evtId();
    const first = await main.captureWellFormed(wellFormed(eventBody(id)));
    const altered = eventBody(id, { data: { object: { id: 'sub_999', object: 'subscription', customer: 'cus_999' } } });
    const c1 = await main.captureWellFormed(wellFormed(altered));
    const c2 = await main.captureWellFormed(wellFormed(altered));
    expect(c1).toMatchObject({ outcome: 'conflict', eventRecordId: (first as { eventRecordId: string }).eventRecordId, conflictRecorded: true });
    expect(c2).toMatchObject({ outcome: 'conflict', conflictRecorded: false });
    expect((await sql('select count(*)::int n from stripe_provider_event_conflicts where event_record_id=$1', [c1.eventRecordId]))[0].n).toBe(1);
    expect((await sql(`select count(*)::int n from stripe_provider_event_dispositions where event_record_id=$1 and disposition='quarantined' and 'QR_DIGEST_CONFLICT'=any(reason_codes)`, [c1.eventRecordId]))[0].n).toBe(1);
    // the original evidence is untouched
    expect(new TextDecoder().decode(await (await readerFor()).readEvent(c1.eventRecordId, CTX))).toBe(eventBody(id));
  });

  it('T06: 12 concurrent identical deliveries on separate connections create one row; exactly one capture, the rest replay', async () => {
    const body = eventBody(evtId());
    const stores = await Promise.all(Array.from({ length: 12 }, () => newStore()));
    const results = await Promise.all(stores.map(s => s.captureWellFormed(wellFormed(body))));
    expect(results.filter(r => r.outcome === 'captured')).toHaveLength(1);
    expect(results.filter(r => r.outcome === 'replay')).toHaveLength(11);
    expect(new Set(results.map(r => r.eventRecordId)).size).toBe(1);
    expect((await sql('select count(*)::int n from stripe_provider_events where stripe_event_id=$1', [JSON.parse(body).id]))[0].n).toBe(1);
  });

  it('T13/T14: DEK creation is race-safe (one wrapped row per cohort+kek under concurrency) and all writers share the winner DEK', async () => {
    const future = monthsFrom(new Date(), 1); // a cohort that has no DEK yet
    const stores = await Promise.all(Array.from({ length: 8 }, () => newStore(keyring, () => new Date(future.getTime() + 86400000))));
    const bodies = Array.from({ length: 8 }, () => eventBody(evtId()));
    const results = await Promise.all(stores.map((s, i) => s.captureWellFormed(wellFormed(bodies[i]!))));
    expect(results.every(r => r.outcome === 'captured')).toBe(true);
    expect((await sql('select count(*)::int n from stripe_evidence_keys where cohort=$1', [cohortOf(future)]))[0].n).toBe(1);
    // every row decrypts via the single stored DEK
    const reader = await readerFor();
    for (let i = 0; i < results.length; i++) expect(new TextDecoder().decode(await reader.readEvent(results[i]!.eventRecordId, CTX))).toBe(bodies[i]);
  });

  it('T13: a cohort whose KEKs the Worker does not hold fails closed (no capture, no partial row)', async () => {
    const other = await loadKeyring(JSON.stringify({ v: 1, keys: [0, 1, 2].map(n => { const st = monthsFrom(new Date(), n); return { cohort: cohortOf(st), kek_version: 'v1', alg: 'AES-256-GCM', key: randomBytes(32).toString('base64'), not_before: st.toISOString(), not_after: '2100-01-01T00:00:00Z', active: true }; }) }), new Date()); // different keys, same versions
    const s = await newStore(other);
    const id = evtId();
    await expect(s.captureWellFormed(wellFormed(eventBody(id)))).rejects.toThrow(); // unwrap fails: wrong KEK
    expect((await sql('select count(*)::int n from stripe_provider_events where stripe_event_id=$1', [id]))[0].n).toBe(0);
    const missing = await loadKeyring(JSON.stringify({ v: 1, keys: [
      ...[1, 2].map(n => ({ cohort: cohortOf(monthsFrom(new Date(), n)), kek_version: 'zz', alg: 'AES-256-GCM', key: randomBytes(32).toString('base64'), not_before: monthsFrom(new Date(), n).toISOString(), not_after: '2100-01-01T00:00:00Z', active: true })),
      { cohort: cohortOf(new Date()), kek_version: 'zz', alg: 'AES-256-GCM', key: randomBytes(32).toString('base64'), not_before: monthsFrom(new Date(), 0).toISOString(), not_after: '2100-01-01T00:00:00Z', active: true },
    ] }), new Date());
    await expect(((await newStore(missing)).captureWellFormed(wellFormed(eventBody(evtId()))))).rejects.toBeInstanceOf(EvidenceStoreError);
  });

  it('T35: malformed bodies are captured as receipts (idempotent by digest), with no inbox row and no claim', async () => {
    const body = `not json ${randomUUID()}`;
    const a = await main.captureMalformed(malformed(body));
    const b = await main.captureMalformed(malformed(body));
    expect(a.outcome).toBe('captured');
    expect(b).toEqual({ outcome: 'replay', receiptId: a.receiptId });
    const row = (await sql('select parse_status, shape_defects, reason_codes from stripe_provider_malformed_receipts where id=$1', [a.receiptId]))[0];
    expect(row.parse_status).toBe('not_json');
    expect(row.reason_codes).toContain('QR_SHAPE_INVALID');
    const stores = await Promise.all(Array.from({ length: 8 }, () => newStore()));
    const body2 = `[1,${randomUUID()}]`;
    const rs = await Promise.all(stores.map(s => s.captureMalformed(malformed(body2))));
    expect(rs.filter(r => r.outcome === 'captured')).toHaveLength(1);
    expect(new Set(rs.map(r => r.receiptId)).size).toBe(1);
    // a signed envelope with a bad Connect account is kept as a receipt too
    const odd = eventBody(evtId(), { account: 'not-an-account' });
    const c = await main.captureMalformed(malformed(odd));
    expect((await sql('select shape_defects from stripe_provider_malformed_receipts where id=$1', [c.receiptId]))[0].shape_defects).toContain('bad_account');
  });

  it('T36: a Connect-style event is captured as scope connect under the receiving account (classification quarantines it later)', async () => {
    const r = await main.captureWellFormed(wellFormed(eventBody(evtId(), { account: 'acct_CONNECTED' })));
    expect(r.outcome).toBe('captured');
    expect((await sql('select account_scope, receiving_account_id, event_account_id from stripe_provider_events where id=$1', [r.eventRecordId]))[0]).toEqual({ account_scope: 'connect', receiving_account_id: RECEIVING, event_account_id: 'acct_CONNECTED' });
  });

  it('T38: 12 concurrent claimants, exactly one wins; the rest see in_progress', async () => {
    const cap = await main.captureWellFormed(wellFormed(eventBody(evtId())));
    const stores = await Promise.all(Array.from({ length: 12 }, () => newStore()));
    const results = await Promise.all(stores.map((s, i) => s.claim(cap.eventRecordId, `w${i}`, 600)));
    expect(results.filter(r => r.state === 'claimed')).toHaveLength(1);
    expect(results.filter(r => r.state === 'in_progress')).toHaveLength(11);
    expect((await dispositions(cap.eventRecordId)).filter(d => d.disposition === 'processing_claimed')).toHaveLength(1);
  });

  it('T39: completion markers stop re-processing; failed is non-completing; expired leases are re-claimable (crash matrix)', async () => {
    // applied -> complete
    const a = await main.captureWellFormed(wellFormed(eventBody(evtId())));
    const ca = await main.claim(a.eventRecordId, 'w1', 600);
    expect(ca).toMatchObject({ state: 'claimed', attemptNo: 1 });
    await main.recordOutcome(a.eventRecordId, 1, 'projection_applied');
    expect(await main.claim(a.eventRecordId, 'w2', 600)).toEqual({ state: 'complete' });

    // skipped -> complete
    const s = await main.captureWellFormed(wellFormed(eventBody(evtId())));
    await main.claim(s.eventRecordId, 'w1', 600);
    await main.recordOutcome(s.eventRecordId, 1, 'projection_skipped');
    expect(await main.claim(s.eventRecordId, 'w2', 600)).toEqual({ state: 'complete' });

    // failed -> next attempt immediately, then applied
    const f = await main.captureWellFormed(wellFormed(eventBody(evtId())));
    await main.claim(f.eventRecordId, 'w1', 600);
    await main.recordOutcome(f.eventRecordId, 1, 'projection_failed', { reasonCodes: ['E_TEST'] });
    expect(await main.claim(f.eventRecordId, 'w2', 600)).toMatchObject({ state: 'claimed', attemptNo: 2 });
    await main.recordOutcome(f.eventRecordId, 2, 'projection_applied');
    expect(await main.claim(f.eventRecordId, 'w3', 600)).toEqual({ state: 'complete' });

    // crash after claim: in_progress until the lease expires (database clock), then attempt 2
    const x = await main.captureWellFormed(wellFormed(eventBody(evtId())));
    expect(await main.claim(x.eventRecordId, 'crashed', 1)).toMatchObject({ state: 'claimed', attemptNo: 1 });
    expect(await main.claim(x.eventRecordId, 'w2', 1)).toEqual({ state: 'in_progress' });
    await new Promise(r => setTimeout(r, 1300));
    expect(await main.claim(x.eventRecordId, 'w2', 600)).toMatchObject({ state: 'claimed', attemptNo: 2 });

    // annotations are never completion markers (a quarantine annotation does not suppress processing, H20)
    const q = await main.captureWellFormed(wellFormed(eventBody(evtId())));
    await main.annotate(q.eventRecordId, 'quarantined', ['QR_MODE_MISMATCH']);
    expect(await main.claim(q.eventRecordId, 'w1', 600)).toMatchObject({ state: 'claimed', attemptNo: 1 });
  });

  it('records an outcome only for a real claimed attempt', async () => {
    const e = await main.captureWellFormed(wellFormed(eventBody(evtId())));
    await expect(main.recordOutcome(e.eventRecordId, 1, 'projection_applied')).rejects.toBeInstanceOf(EvidenceStoreError);
    await main.claim(e.eventRecordId, 'w1', 600);
    await expect(main.recordOutcome(e.eventRecordId, 2, 'projection_applied')).rejects.toBeInstanceOf(EvidenceStoreError);
  });

  it('T06 (full path): 10 concurrent identical deliveries run capture then claim; one processes, the rest wait or complete', async () => {
    const body = eventBody(evtId());
    const stores = await Promise.all(Array.from({ length: 10 }, () => newStore()));
    const out = await Promise.all(stores.map(async (st, i) => {
      const cap = await st.captureWellFormed(wellFormed(body));
      return { cap, claim: await st.claim(cap.eventRecordId, `w${i}`, 600) };
    }));
    expect(out.filter(o => o.claim.state === 'claimed')).toHaveLength(1);
    expect(out.filter(o => o.claim.state === 'in_progress')).toHaveLength(9);
    expect(new Set(out.map(o => o.cap.eventRecordId)).size).toBe(1);
  });

  it('refuses an empty body', async () => {
    const w = wellFormed(eventBody(evtId()));
    await expect(main.captureWellFormed({ ...w, rawBody: new Uint8Array(0) })).rejects.toBeInstanceOf(EvidenceStoreError);
  });
});
