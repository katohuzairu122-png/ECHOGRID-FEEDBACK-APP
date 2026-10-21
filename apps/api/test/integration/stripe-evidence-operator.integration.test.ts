import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import Stripe from 'stripe';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { buildDb, type Database } from '../../src/db/client';
import {
  StripeEvidenceStore, ForensicReader, ForensicAccessError, loadKeyring, classifyEnvelope, assembleKeyring, addKeyringEntry, completeRotation, generateKekEntry, importKek,
  recordKekGenerated, rewrapCohort, verifyRemovalSafe, runAttestation, handleEnforcedCapture, DEFAULT_REQUIRED_EVENT_TYPES,
  type AttestationObservation, type CaptureEnv, type KeyringEntryJson,
} from '../../src/billing/stripe-evidence';

/**
 * HETA-01-F1 operator tooling against a DISPOSABLE PostgreSQL: L2 attestation recording feeding Class S, end-to-end
 * keyring rotation over real wrapped DEKs and sealed events, custody inventory, and the CLI's safety rails.
 * Evidence tables are append-only; cohorts and accounts are random per run so reruns do not collide.
 */
describe.skipIf(!process.env.DATABASE_URL)('stripe evidence operator tooling (integration, disposable database)', () => {
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

  const acct = () => `acct_O${randomBytes(6).toString('hex')}`;
  const URL_OK = 'https://api.example.com/webhooks/stripe';
  const observation = (accountId: string, over: Partial<AttestationObservation> = {}): AttestationObservation => ({
    accountId, keyLivemode: false, restrictedKey: true,
    listing: { complete: true, pages: 1, endpoints: [{ id: 'we_1', url: URL_OK, status: 'enabled', livemode: false, apiVersion: '2026-05-27.dahlia', enabledEvents: [...DEFAULT_REQUIRED_EVENT_TYPES], application: null }] }, ...over,
  });
  const expectationFor = (accountId: string) => ({ accountId, livemode: false, endpointUrl: URL_OK, approvedApiVersions: ['2026-05-27.dahlia'], requiredEventTypes: [...DEFAULT_REQUIRED_EVENT_TYPES] });

  it('records every attempt; a later failure supersedes a pass; a dry run records nothing', async () => {
    const a = acct();
    const db = await newDb();
    const run = (o: AttestationObservation, dryRun = false) => runAttestation({ db, observe: async () => o, expectation: expectationFor(a), commitSha: 'abc123', actor: 'test', dryRun });
    expect((await run(observation(a), true)).recorded).toBe(false);
    expect(await rows(`select 1 from stripe_evidence_control_events where stream=$1`, [`${a}:false`])).toHaveLength(0);
    const pass = await run(observation(a));
    expect(pass).toMatchObject({ result: 'passed', recorded: true, stream: `${a}:false` });
    const fail = await run(observation(a, { accountId: 'acct_SOMEONEELSE' }));
    expect(fail).toMatchObject({ result: 'failed', failures: ['ACCOUNT_MISMATCH'] });
    const all = await rows(`select details, commit_sha, actor from stripe_evidence_control_events where stream=$1 and event_kind='account_provenance_verified' order by seq`, [`${a}:false`]);
    expect(all.map(r => r.details.result)).toEqual(['passed', 'failed']);
    expect(all[0]).toMatchObject({ commit_sha: 'abc123', actor: 'test' });
    expect(JSON.stringify(all)).not.toMatch(/rk_|sk_|whsec_/);
  });

  it('an observation error is recorded as a failed attempt, not thrown away', async () => {
    const a = acct();
    const db = await newDb();
    const out = await runAttestation({ db, observe: async () => { throw new Error('socket hang up with secret rk_live_abc'); }, expectation: expectationFor(a), commitSha: null, actor: 'test' });
    expect(out.result).toBe('failed');
    expect(out.failures).toContain('STRIPE_API_ERROR');
    const r = await rows(`select details from stripe_evidence_control_events where stream=$1`, [`${a}:false`]);
    expect(r).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('rk_live_abc'); // only the error NAME is kept, never its message
  });

  it('a recorded passing attestation satisfies Class S end to end: the capture handler goes from 503 to 200', async () => {
    const a = acct();
    const db = await newDb();
    const month = (n: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); };
    // Same deterministic per-cohort test KEKs as the other suites: the current cohort's DEK is shared (and uncleanable) in this database.
    const kekFor = (c: string) => createHash('sha256').update(`heta01-f1-test-kek:${c}`).digest().toString('base64');
    const ringEntries = [0, 1, 2].map(n => { const c = `${month(n).getUTCFullYear()}-${String(month(n).getUTCMonth() + 1).padStart(2, '0')}`; return { ...generateKekEntry({ cohort: c, kekVersion: 'v1' }), key: kekFor(c) }; });
    const env: CaptureEnv = {
      STRIPE_EVIDENCE_CAPTURE: 'enforced', STRIPE_ACCOUNT_ID: a, STRIPE_EXPECTED_LIVEMODE: 'false', STRIPE_WEBHOOK_SECRET: 'whsec_op',
      EVIDENCE_KEK_KEYRING: assembleKeyring(ringEntries), EVIDENCE_RETENTION_POLICY_VERSION: 'test-v1', EVIDENCE_RETENTION_DAYS: '30',
    };
    const body = JSON.stringify({ id: `evt_o${randomBytes(6).toString('hex')}`, type: 'customer.subscription.updated', created: 1700000000, livemode: false, data: { object: { id: 'sub_o', object: 'subscription' } } });
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret: 'whsec_op', timestamp: Math.floor(Date.now() / 1000), cryptoProvider: Stripe.createSubtleCryptoProvider() });
    const call = () => handleEnforcedCapture({
      rawBody: body, signatureHeader: header, contentLength: null, env,
      openDb: async () => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return { db: buildDb(c), close: async () => { await c.end().catch(() => undefined); } }; },
      runLegacy: async () => undefined,
    });
    expect((await call()).status).toBe(503);
    await runAttestation({ db, observe: async () => observation(a), expectation: expectationFor(a), commitSha: 'abc', actor: 'test' });
    expect((await call()).status).toBe(200);
  });

  it('Class S: a keyring that holds none of the existing cohort KEKs is 503 (nothing stored, bucketed), not a 500', async () => {
    const a = acct();
    const db = await newDb();
    await runAttestation({ db, observe: async () => observation(a), expectation: expectationFor(a), commitSha: 'abc', actor: 'test' });
    const month = (n: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); };
    // Random KEKs under the SAME cohort/version labels the other suites already wrapped a DEK with: unwrap must fail.
    const wrong = [0, 1, 2].map(n => generateKekEntry({ cohort: `${month(n).getUTCFullYear()}-${String(month(n).getUTCMonth() + 1).padStart(2, '0')}`, kekVersion: 'v1' }));
    const env: CaptureEnv = { STRIPE_EVIDENCE_CAPTURE: 'enforced', STRIPE_ACCOUNT_ID: a, STRIPE_EXPECTED_LIVEMODE: 'false', STRIPE_WEBHOOK_SECRET: 'whsec_op', EVIDENCE_KEK_KEYRING: assembleKeyring(wrong), EVIDENCE_RETENTION_POLICY_VERSION: 'test-v1', EVIDENCE_RETENTION_DAYS: '30' };
    const body = JSON.stringify({ id: `evt_o${randomBytes(6).toString('hex')}`, type: 'customer.subscription.updated', created: 1700000000, livemode: false, data: { object: { id: 'sub_k', object: 'subscription' } } });
    const header = await Stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret: 'whsec_op', timestamp: Math.floor(Date.now() / 1000), cryptoProvider: Stripe.createSubtleCryptoProvider() });
    const r = await handleEnforcedCapture({
      rawBody: body, signatureHeader: header, contentLength: null, env,
      openDb: async () => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return { db: buildDb(c), close: async () => { await c.end().catch(() => undefined); } }; },
      runLegacy: async () => { throw new Error('must not run'); },
    });
    expect(r).toEqual({ status: 503, body: { error: 'CAPTURE_PRECONDITION_FAILED' } });
    expect(await rows(`select 1 from stripe_provider_events where receiving_account_id=$1`, [a])).toHaveLength(0);
    const b = await rows(`select details from stripe_evidence_control_events where stream=$1 and event_kind='capture_precondition_failed'`, [`${a}:false`]);
    expect(JSON.stringify(b)).toContain('KEK_UNAVAILABLE');
  });

  it('custody inventory: kek_generated records versions and locations only, idempotently, and rejects unknown locations', async () => {
    const db = await newDb();
    const cohort = '2099-01';
    const v = `inv${randomBytes(3).toString('hex')}`;
    expect(await recordKekGenerated(db, { cohort, kekVersion: v, locations: ['worker_secret', 'primary_escrow'], actor: 'test', commitSha: 'abc', approvalRef: 'CHG-1' })).toBe(true);
    expect(await recordKekGenerated(db, { cohort, kekVersion: v, locations: ['worker_secret', 'primary_escrow'], actor: 'test' })).toBe(false);
    const r = (await rows(`select details from stripe_evidence_control_events where dedupe_key=$1`, [`kekgen:${cohort}:${v}`]))[0];
    expect(r.details).toEqual({ cohort, kekVersion: v, locations: ['worker_secret', 'primary_escrow'] });
    await expect(recordKekGenerated(db, { cohort, kekVersion: 'x', locations: ['dropbox' as never], actor: 'test' })).rejects.toThrow();
    await expect(recordKekGenerated(db, { cohort, kekVersion: 'x', locations: [], actor: 'test' })).rejects.toThrow();
  });

  describe('end-to-end KEK rotation over real wrapped DEKs and sealed events', () => {
    // A cohort in a random far-future month, with injected clocks, so it cannot collide with other tests or reruns.
    const year = 2200 + Math.floor(Math.random() * 7000);
    const mm = String(1 + Math.floor(Math.random() * 10)).padStart(2, '0'); // 01-10 so month+2 stays in the same year
    const cohort = `${year}-${mm}`;
    const next = `${year}-${String(Number(mm) + 1).padStart(2, '0')}`;
    const NOW = new Date(Date.UTC(year, Number(mm) - 1, 15, 12));
    const receiving = acct();
    const old = generateKekEntry({ cohort, kekVersion: 'r1' });
    const runway = generateKekEntry({ cohort: next, kekVersion: 'r1' });
    const fresh = generateKekEntry({ cohort, kekVersion: 'r2' });
    let ring0: string;
    let eventId = '';
    const bodyText = JSON.stringify({ id: `evt_r${randomBytes(6).toString('hex')}`, type: 'customer.subscription.updated', created: 1700000000, livemode: false, data: { object: { id: 'sub_rot', object: 'subscription', customer: 'cus_rot' } } });

    const CTX = { actor: 'test', reason: 'rotation drill' };
    const readerFor = async (ringJson: string, db: Database) => new ForensicReader(db, await loadKeyring(ringJson, NOW));
    const storeFor = async (ringJson: string, db: Database) => new StripeEvidenceStore(db, { receivingAccountId: receiving, keyring: await loadKeyring(ringJson, NOW), now: () => NOW });

    it('captures under v1, then phase 1 adds v2 inactive and the Worker still reads and writes', async () => {
      const db = await newDb();
      const attestationId = (await rows(`insert into stripe_evidence_control_events(event_kind,actor,stream,details) values ('account_provenance_verified','t',$1,'{"result":"passed"}') returning id`, [`${receiving}:false`]))[0].id;
      ring0 = assembleKeyring([old, runway]);
      const store = await storeFor(ring0, db);
      const shape = classifyEnvelope(bodyText);
      if (shape.kind !== 'ok') throw new Error('fixture');
      const r = await store.captureWellFormed({ rawBody: new TextEncoder().encode(bodyText), envelope: shape.envelope, signature: { headerTimestamp: 1, scheme: 'v1', secretLabel: 'p', verifiedAt: NOW, verifierVersion: 't' }, receivedAt: NOW, attestationEventId: attestationId, retention: { policyVersion: 'v', retainUntil: new Date(NOW.getTime() + 86400000) } });
      expect(r.outcome).toBe('captured');
      eventId = r.eventRecordId;
      const ring1 = addKeyringEntry(ring0, fresh);
      expect(new TextDecoder().decode(await (await readerFor(ring1, db)).readEvent(eventId, CTX))).toBe(bodyText);
    });

    it('rewrap without --apply verifies but writes nothing; with a wrong old KEK it fails and writes nothing', async () => {
      const db = await newDb();
      const dry = await rewrapCohort(db, { cohort, fromVersion: 'r1', toVersion: 'r2', oldKek: await importKek(old), newKek: await importKek(fresh), actor: 't', apply: false });
      expect(dry).toMatchObject({ verified: true, applied: false });
      expect(await rows(`select 1 from stripe_evidence_keys where cohort=$1 and kek_version='r2'`, [cohort])).toHaveLength(0);
      await expect(rewrapCohort(db, { cohort, fromVersion: 'r1', toVersion: 'r2', oldKek: await importKek(generateKekEntry({ cohort, kekVersion: 'zz' })), newKek: await importKek(fresh), actor: 't', apply: true })).rejects.toMatchObject({ code: 'UNWRAP_FAILED' });
      expect(await rows(`select 1 from stripe_evidence_keys where cohort=$1 and kek_version='r2'`, [cohort])).toHaveLength(0);
    });

    it('removal is refused before the re-wrapped row exists', async () => {
      const db = await newDb();
      const ring1 = addKeyringEntry(ring0, fresh);
      const ring2 = completeRotation(ring1, cohort, 'r1', 'r2');
      const check = await verifyRemovalSafe(db, { cohort, removeVersion: 'r1', remainingKeyringJson: ring2, now: NOW });
      expect(check.safe).toBe(false);
      expect(check.reasons).toContain('NO_REMAINING_KEK_UNWRAPS_SAME_DEK');
    });

    it('apply inserts the re-wrapped row (same DEK fingerprint) and a versions-only kek_rotated event; a repeat is refused', async () => {
      const db = await newDb();
      const res = await rewrapCohort(db, { cohort, fromVersion: 'r1', toVersion: 'r2', oldKek: await importKek(old), newKek: await importKek(fresh), actor: 't', commitSha: 'abc', approvalRef: 'CHG-2', apply: true });
      expect(res).toMatchObject({ verified: true, applied: true });
      const keys = await rows(`select kek_version, encode(dek_fingerprint,'hex') fp from stripe_evidence_keys where cohort=$1 order by kek_version`, [cohort]);
      expect(keys.map(k => k.kek_version)).toEqual(['r1', 'r2']);
      expect(keys[0].fp).toBe(keys[1].fp);
      const ev = (await rows(`select details, commit_sha, approval_ref from stripe_evidence_control_events where event_kind='kek_rotated' and dedupe_key=$1`, [`kekrot:${cohort}:r1:r2`]))[0];
      expect(ev.details).toEqual({ cohort, fromVersion: 'r1', toVersion: 'r2' });
      expect(ev).toMatchObject({ commit_sha: 'abc', approval_ref: 'CHG-2' });
      await expect(rewrapCohort(db, { cohort, fromVersion: 'r1', toVersion: 'r2', oldKek: await importKek(old), newKek: await importKek(fresh), actor: 't', apply: true })).rejects.toThrow(/already exists/);
      // ciphertext rows untouched: still exactly one event row with its original digest
      expect(await rows(`select 1 from stripe_provider_events where id=$1`, [eventId])).toHaveLength(1);
    });

    it('phase 2 is allowed only now; afterwards the Worker (with ONLY the new KEK) reads old evidence and keeps capturing', async () => {
      const db = await newDb();
      const ring1 = addKeyringEntry(ring0, fresh);
      const ring2 = completeRotation(ring1, cohort, 'r1', 'r2');
      expect(await verifyRemovalSafe(db, { cohort, removeVersion: 'r1', remainingKeyringJson: ring2, now: NOW })).toEqual({ safe: true, reasons: [] });
      const store2 = await storeFor(ring2, db);
      expect(new TextDecoder().decode(await (await readerFor(ring2, db)).readEvent(eventId, CTX))).toBe(bodyText);
      const attestationId = (await rows(`select id from stripe_evidence_control_events where stream=$1 limit 1`, [`${receiving}:false`]))[0].id;
      const body2 = JSON.stringify({ id: `evt_r${randomBytes(6).toString('hex')}`, type: 'customer.subscription.created', created: 1700000001, livemode: false, data: { object: { id: 'sub_rot2', object: 'subscription' } } });
      const shape = classifyEnvelope(body2);
      if (shape.kind !== 'ok') throw new Error('fixture');
      const w = await store2.captureWellFormed({ rawBody: new TextEncoder().encode(body2), envelope: shape.envelope, signature: { headerTimestamp: 1, scheme: 'v1', secretLabel: 'p', verifiedAt: NOW, verifierVersion: 't' }, receivedAt: NOW, attestationEventId: attestationId, retention: { policyVersion: 'v', retainUntil: new Date(NOW.getTime() + 86400000) } });
      expect(w.outcome).toBe('captured');
      expect(new TextDecoder().decode(await (await readerFor(ring2, db)).readEvent(w.eventRecordId, CTX))).toBe(body2);
    });

    it('with every KEK for the cohort absent, the Worker cannot read (an application-level failure only; no irrecoverability is claimed)', async () => {
      const db = await newDb();
      const other = generateKekEntry({ cohort, kekVersion: 'zz' });
      const noKeys = await readerFor(assembleKeyring([other, runway]), db);
      await expect(noKeys.readEvent(eventId, CTX)).rejects.toBeInstanceOf(ForensicAccessError);
    });
  });

  describe('keyring CLI safety rails', () => {
    const cwd = resolve(__dirname, '../..');
    const cli = (args: string[], env: Record<string, string> = {}) => spawnSync('pnpm', ['exec', 'tsx', 'scripts/stripe-evidence/keyring.ts', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    const dir = mkdtempSync(join(tmpdir(), 'evidence-cli-'));

    it('generate writes a 0600 file, prints no key, refuses to overwrite; assemble and validate round-trip through the Worker loader', () => {
      const e1 = join(dir, 'e1.json'), e2 = join(dir, 'e2.json'), ring = join(dir, 'ring.json');
      const now = new Date();
      const c = (n: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
      const g1 = cli(['generate', '--cohort', c(0), '--version', 'c1', '--out', e1]);
      expect(g1.status, g1.stderr).toBe(0);
      const key = (JSON.parse(readFileSync(e1, 'utf8')) as KeyringEntryJson).key;
      expect(g1.stdout).not.toContain(key);
      expect(statSync(e1).mode & 0o777).toBe(0o600);
      expect(cli(['generate', '--cohort', c(0), '--version', 'c1', '--out', e1]).status).not.toBe(0); // no overwrite
      expect(cli(['generate', '--cohort', c(1), '--version', 'c1', '--out', e2]).status).toBe(0);
      const asm = cli(['assemble', '--entry', e1, '--entry', e2, '--out', ring]);
      expect(asm.status, asm.stderr).toBe(0);
      expect(asm.stdout).not.toContain(key);
      expect(JSON.parse(cli(['validate', '--keyring', ring]).stdout)).toEqual({ valid: true });
      expect(existsSync(ring)).toBe(true);
    });

    it('validate prints a code only for a bad keyring; the DB commands refuse a wrong --expect-database', () => {
      const bad = join(dir, 'bad.json');
      execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(bad)}, '{"v":1,"keys":[]}')`]);
      const v = cli(['validate', '--keyring', bad]);
      expect(JSON.parse(v.stdout)).toMatchObject({ valid: false, code: 'KEYRING_SCHEMA' });
      const g = cli(['record-generated', '--cohort', '2099-01', '--version', 'x', '--locations', 'worker_secret', '--expect-database', 'definitely_not_this_database'], { DATABASE_URL: process.env.DATABASE_URL! });
      expect(g.status).not.toBe(0);
      expect(g.stderr).toMatch(/refusing: connected database/);
    });
  });
});
