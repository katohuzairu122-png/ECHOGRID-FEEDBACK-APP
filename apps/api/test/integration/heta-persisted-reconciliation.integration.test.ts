import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { HetaRevisionChain, HetaWorkQueue, dispositionOf, recordProvenanceComparison } from '../../src/billing/stripe-evidence/persisted-reconciliation';
import { createBenefitScratch } from './helpers/benefit-scratch';

/** HETA Block G persisted foundations (0051) against a real PostgreSQL scratch database. Disposable server only. */
type Scratch = Awaited<ReturnType<typeof createBenefitScratch>>;
let s: Scratch;
let queue: HetaWorkQueue;
let chain: HetaRevisionChain;
// Fake clock starts one day ahead so every enqueued item (not_before = real now) is already due.
const T0 = new Date(Date.now() + 86_400_000);
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const errText = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
const rejects = async (p: Promise<unknown>, re: RegExp) => { let msg = ''; try { await p; } catch (e) { msg = errText(e); } expect(msg).toMatch(re); };

let seq = 0;
async function forgeEvent(provenance: 'webhook_signature' | 'api_retrieval', eventId: string, opts: { account?: string; livemode?: boolean } = {}) {
  const c = await s.connect();
  await c.query('SET session_replication_role = replica');
  const acct = opts.account ?? 'acct_G1';
  const web = provenance === 'webhook_signature';
  const n = ++seq;
  const r = await c.query<{ id: string }>(
    `insert into stripe_provider_events(receiving_account_id,event_account_id,account_scope,livemode,stripe_event_id,provenance,attestation_event_id,event_type,provider_created_unix,provider_created_at,received_at,
       payload_sha256,payload_ciphertext,payload_nonce,payload_key_cohort,kek_version,payload_bytes,sig_header_timestamp,sig_scheme,signing_secret_label,verified_at,verifier_version,
       retrieved_at,retrieval_run_id,retrieval_api_version,capture_mode,projection_mode,retention_policy_version,retain_until)
     values($1,$1,'direct',$2,$3,$4,gen_random_uuid(),'invoice.paid',1790000000,to_timestamp(1790000000),now(),$5,$6,$7,'c1','k1',10,
       $8,$9,$10,$11,$12,$13,$14,$15,'enforced','legacy','v1',now()+interval '1 year') returning id`,
    [acct, opts.livemode ?? false, eventId, provenance, randomBytes(32), randomBytes(16), randomBytes(12),
      web ? 1790000000 : null, web ? 'v1' : null, web ? 'lbl' : null, web ? new Date() : null, web ? 'v' : null,
      web ? null : new Date(), web ? null : crypto.randomUUID(), web ? null : '2025-01-01']);
  void n;
  return r.rows[0]!.id;
}

beforeAll(async () => {
  s = await createBenefitScratch('hg');
  const db = buildDb(await s.connect());
  queue = new HetaWorkQueue(db);
  chain = new HetaRevisionChain(db);
}, 300_000);
afterAll(async () => { await s?.close(); });

describe('G5 durable work queue', () => {
  // Tests share one fake clock and the same kinds, so each starts from an empty queue. The guard is disabled only on this disposable database.
  beforeEach(async () => {
    await s.admin.query('ALTER TABLE heta_reconciliation_work DISABLE TRIGGER heta_reconciliation_work_guard');
    await s.admin.query('DELETE FROM heta_reconciliation_work');
    await s.admin.query('ALTER TABLE heta_reconciliation_work ENABLE TRIGGER heta_reconciliation_work_guard');
  });

  it('enqueue is idempotent per kind+subject', async () => {
    const a = await queue.enqueue({ kind: 'retrieve_event', subjectKey: 'evt_idem' });
    const b = await queue.enqueue({ kind: 'retrieve_event', subjectKey: 'evt_idem' });
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.id).toBe(a.id);
    const other = await queue.enqueue({ kind: 'compare_provenance', subjectKey: 'evt_idem' });
    expect(other.id).not.toBe(a.id);
  });

  it('concurrent workers get distinct items (SKIP LOCKED), never the same one twice', async () => {
    for (let i = 0; i < 8; i++) await queue.enqueue({ kind: 'reconcile_window', subjectKey: `win_${i}` });
    const workers = await Promise.all(Array.from({ length: 4 }, async () => new HetaWorkQueue(buildDb(await s.connect()))));
    const got = (await Promise.all(workers.map((w, i) => w.claim({ owner: `w${i}`, leaseMs: 60_000, limit: 2, kinds: ['reconcile_window'] })))).flat();
    expect(got.length).toBe(8);
    expect(new Set(got.map(g => g.id)).size).toBe(8);
    expect(new Set(got.map(g => g.leaseToken)).size).toBe(8);
  });

  it('a claimer never waits on a row another worker holds locked (SKIP LOCKED liveness)', async () => {
    const a = await queue.enqueue({ kind: 'reconcile_window', subjectKey: 'lock_a' });
    await queue.enqueue({ kind: 'reconcile_window', subjectKey: 'lock_b' });
    const holder = await s.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM heta_reconciliation_work WHERE id=$1 FOR UPDATE', [a.id]);
    try {
      const got = await Promise.race([
        queue.claim({ owner: 'w', leaseMs: 60_000, limit: 5, kinds: ['reconcile_window'] }),
        new Promise<'blocked'>(r => setTimeout(() => r('blocked'), 3000)),
      ]);
      expect(got).not.toBe('blocked');
      expect((got as { subjectKey: string }[]).map(g => g.subjectKey)).toEqual(['lock_b']);
    } finally { await holder.query('ROLLBACK'); }
  });

  it('a crashed worker\'s lease expires, the item is reclaimed with a new fence, and the old holder is fenced out', async () => {
    await queue.enqueue({ kind: 'retrieve_event', subjectKey: 'evt_crash' });
    const [first] = await queue.claim({ owner: 'dead-worker', leaseMs: 1000, kinds: ['retrieve_event'], now: at(0) });
    expect(first!.attempts).toBe(1);
    expect(await queue.claim({ owner: 'other', leaseMs: 1000, kinds: ['retrieve_event'], now: new Date(at(0).getTime() + 500) })).toHaveLength(0);
    const [second] = await queue.claim({ owner: 'rescuer', leaseMs: 60_000, kinds: ['retrieve_event'], now: new Date(at(0).getTime() + 5000) });
    expect(second!.id).toBe(first!.id); expect(second!.attempts).toBe(2); expect(second!.leaseToken).not.toBe(first!.leaseToken);
    const late = new Date(at(0).getTime() + 6000);
    expect(await queue.complete(first!.id, first!.leaseToken, late)).toBe(false);
    expect(await queue.heartbeat(first!.id, first!.leaseToken, 1000, late)).toBe(false);
    expect(await queue.fail(first!.id, first!.leaseToken, 'x', { now: late })).toBe('stale');
    expect(await queue.heartbeat(second!.id, second!.leaseToken, 60_000, late)).toBe(true);
    expect(await queue.complete(second!.id, second!.leaseToken, late)).toBe(true);
    expect(await queue.complete(second!.id, second!.leaseToken, late)).toBe(false);
  });

  it('an expired lease cannot be completed even by its own token', async () => {
    await queue.enqueue({ kind: 'retrieve_event', subjectKey: 'evt_expired_self' });
    const [w] = await queue.claim({ owner: 'slow', leaseMs: 1000, kinds: ['retrieve_event'], now: at(100) });
    expect(await queue.complete(w!.id, w!.leaseToken, new Date(at(100).getTime() + 2000))).toBe(false);
  });

  it('failure retries with backoff, stores only a redacted code, and exhaustion goes dead', async () => {
    await queue.enqueue({ kind: 'compare_provenance', subjectKey: 'evt_fail', maxAttempts: 2 });
    const [a] = await queue.claim({ owner: 'w', leaseMs: 60_000, kinds: ['compare_provenance'], now: at(200) });
    expect(await queue.fail(a!.id, a!.leaseToken, 'sk_live_SECRET value with spaces', { retryDelayMs: 60_000, now: at(200) })).toBe('retry');
    const row = (await s.rows<{ state: string; last_error_code: string }>('select state,last_error_code from heta_reconciliation_work where id=$1', [a!.id]))[0]!;
    expect(row.state).toBe('pending'); expect(row.last_error_code).toBe('unspecified_error');
    expect(await queue.claim({ owner: 'w', leaseMs: 60_000, kinds: ['compare_provenance'], now: at(200) })).toHaveLength(0); // backoff
    const [b] = await queue.claim({ owner: 'w', leaseMs: 60_000, kinds: ['compare_provenance'], now: at(202) });
    expect(b!.attempts).toBe(2);
    expect(await queue.fail(b!.id, b!.leaseToken, 'provider_timeout', { now: at(202) })).toBe('dead');
    const dead = (await s.rows<{ state: string; last_error_code: string }>('select state,last_error_code from heta_reconciliation_work where id=$1', [a!.id]))[0]!;
    expect(dead.state).toBe('dead'); expect(dead.last_error_code).toBe('provider_timeout');
    expect(await queue.claim({ owner: 'w', leaseMs: 60_000, kinds: ['compare_provenance'], now: at(500) })).toHaveLength(0);
  });

  it('a lease that expires on the final attempt is marked dead, not re-handed out', async () => {
    await queue.enqueue({ kind: 'retrieve_event', subjectKey: 'evt_poison', maxAttempts: 1 });
    await queue.claim({ owner: 'w', leaseMs: 1000, kinds: ['retrieve_event'], now: at(300) });
    expect(await queue.claim({ owner: 'w', leaseMs: 1000, kinds: ['retrieve_event'], now: at(310) })).toHaveLength(0);
    const r = (await s.rows<{ state: string; last_error_code: string }>("select state,last_error_code from heta_reconciliation_work where subject_key='evt_poison'"))[0]!;
    expect(r.state).toBe('dead'); expect(r.last_error_code).toBe('attempts_exhausted');
  });

  it('database guards: terminal work is frozen, identity immutable, no delete, no truncate', async () => {
    await queue.enqueue({ kind: 'retrieve_event', subjectKey: 'evt_terminal' });
    const [w] = await queue.claim({ owner: 'w', leaseMs: 60_000, kinds: ['retrieve_event'], now: at(400) });
    expect(await queue.complete(w!.id, w!.leaseToken, at(400))).toBe(true);
    const done = w!.id;
    await rejects(s.admin.query("update heta_reconciliation_work set state='pending' where id=$1", [done]), /terminal state cannot change/);
    const live = (await queue.enqueue({ kind: 'reconcile_window', subjectKey: 'win_guard' })).id;
    await rejects(s.admin.query("update heta_reconciliation_work set subject_key='other' where id=$1", [live]), /identity is immutable/);
    await rejects(s.admin.query('delete from heta_reconciliation_work where id=$1', [live]), /never deleted/);
    await rejects(s.admin.query('truncate heta_reconciliation_work'), /append-only/);
  });

  it('rejects an invalid claim request', async () => {
    await expect(queue.claim({ owner: '', leaseMs: 5000 })).rejects.toThrow('HETA_WORK_CLAIM_INVALID');
    await expect(queue.claim({ owner: 'w', leaseMs: 10 })).rejects.toThrow('HETA_WORK_CLAIM_INVALID');
  });
});

describe('G2 persisted provenance comparisons', () => {
  it('maps every comparison status to a disposition without inventing agreement', () => {
    expect(dispositionOf(null).disposition).toBe('unassessed');
    expect(dispositionOf({ status: 'matched' } as never).disposition).toBe('corroborated_fields');
    expect(dispositionOf({ status: 'mismatched', mismatches: [{ field: 'amount', webhook: 1, retrieved: 2 }] } as never)).toMatchObject({ disposition: 'conflicted' });
    expect(dispositionOf({ status: 'insufficient_evidence', reasons: ['r'] } as never).disposition).toBe('incomparable');
    expect(dispositionOf({ status: 'unusable_envelope', source: 'webhook', parseStatus: 'malformed', defects: [] } as never).disposition).toBe('incomparable');
  });

  it('persists, replays idempotently, and refuses a contradictory re-record', async () => {
    const w = await forgeEvent('webhook_signature', 'evt_cmp1');
    const r = await forgeEvent('api_retrieval', 'evt_cmp1');
    const a = await recordProvenanceComparison(buildDb(await s.connect()), { webhookRecordId: w, retrievedRecordId: r, comparison: { status: 'matched' } as never, ruleVersion: 'rv1' });
    const b = await recordProvenanceComparison(buildDb(await s.connect()), { webhookRecordId: w, retrievedRecordId: r, comparison: { status: 'matched' } as never, ruleVersion: 'rv1' });
    expect(a.replay).toBe(false); expect(b.replay).toBe(true); expect(b.id).toBe(a.id);
    await expect(recordProvenanceComparison(buildDb(await s.connect()), { webhookRecordId: w, retrievedRecordId: r, comparison: { status: 'mismatched', mismatches: [{ field: 'amount', webhook: 1, retrieved: 2 }] } as never, ruleVersion: 'rv1' })).rejects.toThrow('HETA_COMPARISON_DISPOSITION_CONFLICT');
    // a new rule version is a new, separate record
    const c = await recordProvenanceComparison(buildDb(await s.connect()), { webhookRecordId: w, retrievedRecordId: r, comparison: { status: 'mismatched', mismatches: [{ field: 'amount', webhook: 1, retrieved: 2 }] } as never, ruleVersion: 'rv2' });
    expect(c.replay).toBe(false);
  });

  it('unassessed (no retrieved counterpart) is idempotent and input pairing is enforced', async () => {
    const w = await forgeEvent('webhook_signature', 'evt_cmp2');
    const db = buildDb(await s.connect());
    const a = await recordProvenanceComparison(db, { webhookRecordId: w, retrievedRecordId: null, comparison: null, ruleVersion: 'rv1' });
    const b = await recordProvenanceComparison(db, { webhookRecordId: w, retrievedRecordId: null, comparison: null, ruleVersion: 'rv1' });
    expect(b.replay).toBe(true); expect(b.id).toBe(a.id);
    await expect(recordProvenanceComparison(db, { webhookRecordId: w, retrievedRecordId: w, comparison: null, ruleVersion: 'rv1' })).rejects.toThrow('HETA_COMPARISON_INPUT_INVALID');
  });

  it('the database refuses sides of the wrong provenance and mismatched event identity', async () => {
    const w1 = await forgeEvent('webhook_signature', 'evt_cmp3');
    const w2 = await forgeEvent('webhook_signature', 'evt_cmp3b');
    const rOther = await forgeEvent('api_retrieval', 'evt_cmp3_other');
    const rLive = await forgeEvent('api_retrieval', 'evt_cmp3', { livemode: true });
    const db = buildDb(await s.connect());
    await rejects(recordProvenanceComparison(db, { webhookRecordId: w1, retrievedRecordId: w2, comparison: { status: 'matched' } as never, ruleVersion: 'rv9' }), /retrieved side must be an api_retrieval/);
    await rejects(recordProvenanceComparison(db, { webhookRecordId: rOther, retrievedRecordId: null, comparison: null, ruleVersion: 'rv9' }), /webhook side must be a webhook_signature/);
    await rejects(recordProvenanceComparison(db, { webhookRecordId: w1, retrievedRecordId: rOther, comparison: { status: 'matched' } as never, ruleVersion: 'rv9' }), /same canonical event identity/);
    await rejects(recordProvenanceComparison(db, { webhookRecordId: w1, retrievedRecordId: rLive, comparison: { status: 'matched' } as never, ruleVersion: 'rv9' }), /same canonical event identity/);
  });

  it('results are immutable: no update, delete or truncate', async () => {
    await rejects(s.admin.query("update heta_provenance_comparisons set disposition='conflicted'"), /append-only/);
    await rejects(s.admin.query('delete from heta_provenance_comparisons'), /append-only/);
    await rejects(s.admin.query('truncate heta_provenance_comparisons'), /append-only/);
  });
});

describe('G4 database-backed revision chain', () => {
  it('builds a chain and resolves the effective record', async () => {
    const r1 = await chain.append('att:1', { state: 'active', effectiveFrom: at(0), recordedAt: at(0) }, null);
    expect(r1.ok).toBe(true);
    const head = r1.ok ? r1.head.id : '';
    const r2 = await chain.append('att:1', { state: 'revoked', effectiveFrom: at(10), recordedAt: at(11) }, head);
    expect(r2.ok).toBe(true);
    const eff = await chain.effective('att:1');
    expect(eff.ok && eff.head.state).toBe('revoked');
    expect((await chain.usable('att:1', at(5).getTime())).usable).toBe(true);
    expect((await chain.usable('att:1', at(20).getTime())).usable).toBe(false);
  });

  it('a stale expected predecessor is rejected (no silent overwrite)', async () => {
    const r1 = await chain.append('att:2', { state: 'active', effectiveFrom: at(0), recordedAt: at(0) }, null);
    const head = r1.ok ? r1.head.id : '';
    expect((await chain.append('att:2', { state: 'revoked', effectiveFrom: at(1), recordedAt: at(1) }, head)).ok).toBe(true);
    const stale = await chain.append('att:2', { state: 'compromised', effectiveFrom: at(2), recordedAt: at(2) }, head);
    expect(stale.ok).toBe(false);
  });

  it('concurrent appends against one predecessor: exactly one wins, no fork', async () => {
    const r1 = await chain.append('att:3', { state: 'active', effectiveFrom: at(0), recordedAt: at(0) }, null);
    const head = r1.ok ? r1.head.id : '';
    const writers = await Promise.all(Array.from({ length: 6 }, async () => new HetaRevisionChain(buildDb(await s.connect()))));
    const res = await Promise.all(writers.map(w => w.append('att:3', { state: 'revoked', effectiveFrom: at(5), recordedAt: at(6) }, head)));
    expect(res.filter(r => r.ok)).toHaveLength(1);
    const rows = await s.rows<{ revision: number }>('select revision from heta_record_revisions where scope_key=$1 order by revision', ['att:3']);
    expect(rows.map(r => r.revision)).toEqual([1, 2]);
  });

  it('recovery needs a reference and cannot be retroactive; the floor blocks reaching back over a restricted window', async () => {
    const r1 = await chain.append('att:4', { state: 'active', effectiveFrom: at(0), recordedAt: at(0) }, null);
    const r2 = await chain.append('att:4', { state: 'compromised', effectiveFrom: at(10), recordedAt: at(11) }, r1.ok ? r1.head.id : '');
    const h2 = r2.ok ? r2.head.id : '';
    expect((await chain.append('att:4', { state: 'active', effectiveFrom: at(20), recordedAt: at(21) }, h2)).ok).toBe(false); // no recovery ref
    expect((await chain.append('att:4', { state: 'active', effectiveFrom: at(5), recordedAt: at(21), recoveryRef: 'rec-1' }, h2)).ok).toBe(false); // retroactive
    const r3 = await chain.append('att:4', { state: 'active', effectiveFrom: at(30), recordedAt: at(31), recoveryRef: 'rec-1' }, h2);
    expect(r3.ok).toBe(true);
    const h3 = r3.ok ? r3.head.id : '';
    expect((await chain.append('att:4', { state: 'active', effectiveFrom: at(15), recordedAt: at(32) }, h3)).ok).toBe(false); // would reopen the window
    expect((await chain.usable('att:4', at(15).getTime())).usable).toBe(false);
    expect((await chain.usable('att:4', at(40).getTime())).usable).toBe(true);
  });

  it('the database itself refuses a fork, a gap, a regression and a retroactive restoration (code bypassed)', async () => {
    const r1 = await chain.append('att:5', { state: 'active', effectiveFrom: at(0), recordedAt: at(0) }, null);
    const h1 = r1.ok ? r1.head.id : '';
    const r2 = await chain.append('att:5', { state: 'compromised', effectiveFrom: at(10), recordedAt: at(11) }, h1);
    const h2 = r2.ok ? r2.head.id : '';
    const ins = (rev: number, sup: string | null, state: string, eff: number, rec: number, ref: string | null = null) =>
      s.admin.query('insert into heta_record_revisions(scope_key,revision,supersedes,state,effective_from,recorded_at,recovery_ref) values($1,$2,$3,$4,$5,$6,$7)', ['att:5', rev, sup, state, at(eff), at(rec), ref]);
    await expect(ins(2, h1, 'revoked', 12, 12)).rejects.toThrow(); // fork on revision 2 / second successor of h1
    await rejects(ins(5, h2, 'revoked', 12, 12), /monotonic/);
    await rejects(ins(3, h2, 'revoked', 12, 5), /recorded time cannot regress/);
    await rejects(ins(3, h2, 'active', 20, 20), /recovery reference/);
    await rejects(ins(3, h2, 'active', 5, 20, 'r'), /after the restriction/);
    await rejects(ins(3, crypto.randomUUID(), 'revoked', 12, 12), /unknown predecessor|foreign key|violates/);
    await rejects(s.admin.query("update heta_record_revisions set state='active' where scope_key='att:5'"), /append-only/);
    await rejects(s.admin.query("delete from heta_record_revisions where scope_key='att:5'"), /append-only/);
    await rejects(s.admin.query('truncate heta_record_revisions'), /append-only/);
  });
});
