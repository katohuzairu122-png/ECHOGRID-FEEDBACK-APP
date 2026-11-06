/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows and forged-input fixtures */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import {
  createEvidenceSigningBoundary, createSigningWorkloadAuthority, SignedEvidenceCustodyService, isIssuedCustodyReader, evidenceMessage, canonicalJson, sha256Hex,
  type EvidenceKeyRecord, type SecurityLogEntry, type SignedEvidence,
} from '../../src/billing/stripe-read';
import { createSyntheticCustodyRecorderHandoff } from '../../src/billing/stripe-read/synthetic-custody-recorder-handoff';
import { SettlementAuthorizationRecorder } from '../../src/partner-credits/partner-credit-settlement-authorization';
import { syntheticDirectory, syntheticKey, syntheticSignerProvider, syntheticSigningWorkloadSource, type SyntheticKey } from '../../src/billing/stripe-read/evidence-signing-test-support';

/**
 * S08-D1D3-DEV-15 on PostgreSQL, in a SCRATCH database: durable custody of DEV-14 signed evidence, connected as NON-SUPERUSER application logins. Synthetic disposable keys only; no Stripe, provider, Neon or
 * production resource. The read-authorization policy is never touched; the suite asserts it stays disabled and unchanged.
 */
describe.skipIf(!process.env.DATABASE_URL)('D1/D3-DEV-15 signed-evidence custody (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_d15_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string, user?: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; if (user) { u.username = user; u.password = PW; } return u.toString(); };
  const PW = 'dev15-' + randomBytes(6).toString('hex');
  const clients: Client[] = [];
  let admin: Client; let B1: string; let B2: string; let k1: SyntheticKey;
  const state = { now: 500_000, dir: [] as unknown, signerWl: null as any, custWl: null as any };
  const logs: SecurityLogEntry[] = [];
  const q = async (text: string, params: unknown[] = []) => (await admin.query(text, params)).rows as Array<Record<string, any>>;
  const tryQ = async (c: Client, text: string, params: unknown[] = []) => { try { return { error: '', rows: (await c.query(text, params)).rows as Array<Record<string, any>> }; } catch (e) { return { error: String((e as Error).message), rows: [] as Array<Record<string, any>> }; } };
  const connect = async (login: string) => { const c = new Client({ connectionString: urlFor(dbName, login) }); await c.connect(); clients.push(c); return c; };
  const wl = (role: string, businessIds: string[], over: Record<string, unknown> = {}) => ({ workloadId: `${role === 'EVIDENCE_SIGNER' ? 'signer' : 'custodian'}:d15`, role, environment: 'development', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds, validFromMs: 1_000, expiresAtMs: 900_000, revokedAtMs: null, ...over });
  const dir = () => syntheticDirectory(() => state.dir);
  const clock = () => state.now;
  const signer = () => createEvidenceSigningBoundary({
    authority: createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', () => state.signerWl), environment: 'development', clock }), keys: dir(), signers: syntheticSignerProvider([k1]), environment: 'development', clock,
  });
  const service = (c: Client, o: { policy?: unknown; securityLog?: (e: SecurityLogEntry) => void; custWl?: () => unknown } = {}) => new SignedEvidenceCustodyService({
    db: buildDb(c), authority: createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', o.custWl ?? (() => state.custWl)), environment: 'development', clock, role: 'EVIDENCE_CUSTODIAN' }),
    keys: dir(), policy: o.policy, environment: 'development', clock, securityLog: o.securityLog ?? (e => { logs.push(e); }),
  });
  const exp = (biz = B1) => ({ businessId: biz, purpose: 'SYNTHETIC_TEST_EVIDENCE' as const, evidenceType: 'SYNTHETIC_TEST_EVIDENCE' });
  const mkEvidence = async (payload: Record<string, unknown> = { subject: 'inv_1', n: Math.random() }, biz = B1): Promise<SignedEvidence> => {
    const s = await signer().sign({ businessId: biz, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', payload }); if (!s.ok) throw new Error(`sign: ${s.reason}`); return s.evidence;
  };
  const count = async (t: string) => (await q(`select count(*)::int n from ${t}`))[0]!.n as number;
  const policyRow = async () => (await q('select approval_enabled, version from stripe_read_authorization_policy'))[0]!;
  let custodian: Client; let svc: SignedEvidenceCustodyService; let policyBefore: any;

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') }); await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed: ' + m.stderr.slice(0, 400));
    admin = new Client({ connectionString: urlFor(dbName) }); await admin.connect(); clients.push(admin);
    B1 = (await q("insert into businesses(name,slug,status) values('D15 one','d15-one-" + dbName + "','active') returning id"))[0]!.id; B2 = (await q("insert into businesses(name,slug,status) values('D15 two','d15-two-" + dbName + "','active') returning id"))[0]!.id;
    for (const [l, g] of [['d15_custodian', 'signed_evidence_writer, signed_evidence_reader'], ['d15_writer', 'signed_evidence_writer'], ['d15_reader', 'signed_evidence_reader'], ['d15_auditor', 'signed_evidence_auditor'], ['d15_plain', '']] as const) {
      await q(`CREATE ROLE ${l} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO ${l}`); if (g) await q(`GRANT ${g} TO ${l}`);
    }
    k1 = await syntheticKey({ keyId: 'k-v1' });
    state.dir = [k1.record]; state.signerWl = wl('EVIDENCE_SIGNER', [B1, B2]); state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2]);
    custodian = await connect('d15_custodian'); svc = service(custodian); policyBefore = await policyRow();
  }, 300_000);
  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') }); await root.connect();
    await root.query(`drop database if exists ${dbName} with (force)`); for (const l of ['d15_custodian', 'd15_writer', 'd15_reader', 'd15_auditor', 'd15_plain']) await root.query(`drop role if exists ${l}`).catch(() => undefined); await root.end();
  });

  it('1. authorized synthetic signing, persistence, retrieval and re-verification: the exact signed envelope comes back, authenticity only', async () => {
    const ev = await mkEvidence({ subject: 'inv_1', amountMinor: 1200 }); const id = randomUUID();
    const p = await svc.persist({ evidenceId: id, expected: exp(), evidence: ev });
    expect(p).toMatchObject({ ok: true, outcome: 'PERSISTED', evidenceId: id, financialAuthorization: 'NOT_GRANTED', metadata: { keyId: 'k-v1', keyVersion: 1, algorithm: 'Ed25519', environment: 'development' } });
    const row = (await q('select * from signed_evidence_records where evidence_id=$1', [id]))[0]!;
    expect(row).toMatchObject({ business_id: B1, signature: ev.signature, payload_sha256: ev.claims.payloadSha256, payload_canonical: canonicalJson(ev.payload), custodian_workload_id: 'custodian:d15', signer_workload_id: 'signer:d15', version: 1, persisted_by_db_role: 'd15_custodian' });
    const r = await svc.retrieve({ evidenceId: id, ...exp() });
    expect(r).toMatchObject({ ok: true, authenticity: 'AUTHENTIC', financialAuthorization: 'NOT_GRANTED', keyState: 'ACTIVE', custody: { status: 'STORED', recordVersion: 1, custodianWorkloadId: 'custodian:d15' } });
    if (r.ok) { expect(r.claims).toEqual(ev.claims); expect(r.payload).toEqual(ev.payload); expect(Object.keys(r)).not.toContain('eligible'); }
    const types = (await q('select event_type from signed_evidence_events where evidence_id=$1 order by seq', [id])).map(e => e.event_type);
    expect(types).toEqual(['EVIDENCE_PERSISTED', 'VERIFICATION_ATTEMPTED', 'VERIFICATION_SUCCEEDED']);
  });

  it('1b. the application and database content digests agree for non-ASCII and non-BMP payloads, and the stored canonical text is byte-exact', async () => {
    const payload = { note: 'caf\u00e9 \u{1F9FE} \u4e2d\u6587', nested: { z: 1, a: [1, 2, { b: 'x' }] } }; const id = randomUUID();
    const ev = await mkEvidence(payload);
    expect(await svc.persist({ evidenceId: id, expected: exp(), evidence: ev })).toMatchObject({ ok: true });
    const row = (await q('select * from signed_evidence_records where evidence_id=$1', [id]))[0]!;
    const { contentDigest } = await import('../../src/billing/stripe-read');
    expect(row.content_digest).toBe(await contentDigest({ businessId: B1, signerWorkloadId: row.signer_workload_id, environment: row.environment, purpose: row.purpose, evidenceType: row.evidence_type, schema: row.schema, schemaVersion: row.schema_version, signedAtMs: Number(row.signed_at_ms), keyId: row.key_id, keyVersion: row.key_version, algorithm: row.algorithm, payloadSha256: row.payload_sha256, signature: row.signature, payloadCanonical: row.payload_canonical }));
    expect(Buffer.from(row.payload_canonical, 'utf8').toString('utf8')).toBe(canonicalJson(ev.payload));
    expect(await svc.retrieve({ evidenceId: id, ...exp() })).toMatchObject({ ok: true, payload });
  });

  it('2. identical replay returns the existing record (one row, bounded replay events); a conflicting replay is rejected and replaces nothing', async () => {
    const ev = await mkEvidence({ subject: 'inv_2' }); const id = randomUUID();
    expect((await svc.persist({ evidenceId: id, expected: exp(), evidence: ev })).ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(await svc.persist({ evidenceId: id, expected: exp(), evidence: ev })).toMatchObject({ ok: true, outcome: 'REPLAYED' });
    expect((await q('select count(*)::int n from signed_evidence_records where evidence_id=$1', [id]))[0]!.n).toBe(1);
    expect((await q("select count(*)::int n from signed_evidence_events where evidence_id=$1 and event_type='EVIDENCE_REPLAYED'", [id]))[0]!.n).toBe(1); // bounded: repeats inside the window add nothing
    const other = await mkEvidence({ subject: 'inv_2', different: true });
    expect(await svc.persist({ evidenceId: id, expected: exp(), evidence: other })).toEqual({ ok: false, reason: 'EVIDENCE_CONFLICT' }); // same id, different content
    expect(await svc.persist({ evidenceId: randomUUID(), expected: exp(), evidence: ev })).toEqual({ ok: false, reason: 'EVIDENCE_CONFLICT' }); // same signed evidence under another id
    expect((await q('select signature from signed_evidence_records where evidence_id=$1', [id]))[0]!.signature).toBe(ev.signature);
    expect((await q("select count(*)::int n from signed_evidence_events where event_type='EVIDENCE_CONFLICT_REJECTED' and business_id=$1", [B1]))[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('3. forged, altered, mis-bound and unsupported evidence is rejected BEFORE storage', async () => {
    const ev = await mkEvidence({ subject: 'inv_3' }); const before = await count('signed_evidence_records');
    const clone = (f: (c: any) => void): any => { const c = JSON.parse(JSON.stringify(ev)); f(c); return c; };
    const put = (e: unknown, expected = exp()) => svc.persist({ evidenceId: randomUUID(), expected, evidence: e as SignedEvidence });
    const cases: Array<[string, unknown, ReturnType<typeof exp>?]> = [
      ['SIGNATURE_INVALID', clone(c => { c.signature = (c.signature[0] === 'a' ? 'b' : 'a') + c.signature.slice(1); })],
      ['PAYLOAD_TAMPERED', clone(c => { c.payload.subject = 'inv_9'; })],
      ['BINDING_MISMATCH', ev, exp(B2)], // altered business
      ['INVALID_REQUEST', ev, { ...exp(), evidenceType: 'STRIPE_INVOICE_OBSERVATION' }],
      ['SIGNATURE_INVALID', clone(c => { c.claims.businessId = B2; }), exp(B2)],
      ['KEY_ENVIRONMENT_MISMATCH', clone(c => { c.claims.environment = 'staging'; }), { ...exp() }],
      ['ALGORITHM_UNSUPPORTED', clone(c => { c.claims.algorithm = 'HS256'; })],
      ['SCHEMA_MISMATCH', clone(c => { c.claims.schemaVersion = 2; })],
      ['KEY_UNKNOWN', clone(c => { c.claims.keyId = 'k-unknown'; })],
      ['EVIDENCE_MALFORMED', { claims: {}, payload: {}, signature: '' }],
      ['EVIDENCE_MALFORMED', null],
    ];
    for (const [why, e, ex] of cases) {
      const r = await put(e, ex); if (why === 'KEY_ENVIRONMENT_MISMATCH') { expect(r.ok, why).toBe(false); continue; }
      expect(r, why).toEqual({ ok: false, reason: why });
    }
    expect(await count('signed_evidence_records')).toBe(before);
  });

  it('4. wrong purpose is rejected, and a genuine signature over a verdict-bearing payload is never stored', async () => {
    const ev = await mkEvidence({ subject: 'inv_4' });
    expect(await svc.persist({ evidenceId: randomUUID(), expected: { ...exp(), purpose: 'STRIPE_OBSERVATION_ATTESTATION', evidenceType: 'STRIPE_INVOICE_OBSERVATION' }, evidence: ev })).toEqual({ ok: false, reason: 'SIGNER_PURPOSE_NOT_PERMITTED' });
    // hand-sign (we hold the disposable key) a payload that claims approval: authentic bytes, but custody never carries a financial decision
    const payload = { approved: true, approval_enabled: true }; const sha = await sha256Hex(canonicalJson(payload));
    const claims = { ...ev.claims, signedAtMs: state.now, payloadSha256: sha };
    const sig = Buffer.from(await k1.signer.sign(evidenceMessage(claims))).toString('hex');
    const before = await count('signed_evidence_records');
    expect(await svc.persist({ evidenceId: randomUUID(), expected: exp(), evidence: { claims, payload, signature: sig } })).toEqual({ ok: false, reason: 'PAYLOAD_REJECTED' });
    expect(await count('signed_evidence_records')).toBe(before);
  });

  it('5. unauthorized, expired, revoked, wrong-role and missing workloads are denied before the database and logged on the bounded security channel', async () => {
    const ev = await mkEvidence({ subject: 'inv_5' }); const before = { r: await count('signed_evidence_records'), e: await count('signed_evidence_events') };
    const seen: SecurityLogEntry[] = []; const log = (e: SecurityLogEntry) => { seen.push(e); };
    const attempt = (custWl: () => unknown) => service(custodian, { custWl, securityLog: log }).persist({ evidenceId: randomUUID(), expected: exp(), evidence: ev });
    expect(await attempt(() => null)).toEqual({ ok: false, reason: 'SIGNER_CONFIG_MISSING' });
    expect(await attempt(() => wl('EVIDENCE_SIGNER', [B1]))).toEqual({ ok: false, reason: 'SIGNER_WRONG_ROLE' }); // a signer cannot persist
    expect(await attempt(() => wl('EVIDENCE_CUSTODIAN', [B1], { expiresAtMs: 400_000 }))).toEqual({ ok: false, reason: 'SIGNER_EXPIRED' });
    expect(await attempt(() => wl('EVIDENCE_CUSTODIAN', [B1], { revokedAtMs: 1 }))).toEqual({ ok: false, reason: 'SIGNER_REVOKED' });
    expect(await attempt(() => wl('EVIDENCE_CUSTODIAN', [B1], { environment: 'staging' }))).toEqual({ ok: false, reason: 'SIGNER_WRONG_ENVIRONMENT' });
    expect(await attempt(() => wl('EVIDENCE_CUSTODIAN', [B2]))).toEqual({ ok: false, reason: 'SIGNER_TENANT_NOT_PERMITTED' }); // allowlist excludes the business
    expect(await attempt(() => ({ workloadId: 'custodian:d15' }))).toEqual({ ok: false, reason: 'SIGNER_CONFIG_MALFORMED' });
    expect(seen).toHaveLength(7); expect(seen.every(s => s.event === 'signed_evidence.denied' && s.operation === 'persist' && !JSON.stringify(s).includes(ev.signature))).toBe(true);
    expect({ r: await count('signed_evidence_records'), e: await count('signed_evidence_events') }).toEqual(before);
    // and a signer-role identity from the signing authority cannot be used as a custodian, nor a custodian as a signer
    const signAuth = createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', () => state.signerWl), environment: 'development', clock });
    const custAuth = createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', () => state.custWl), environment: 'development', clock, role: 'EVIDENCE_CUSTODIAN' });
    const use = { environment: 'development', purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', businessId: B1 };
    const si = await signAuth.resolve(); const ci = await custAuth.resolve(); if (!si.ok || !ci.ok) throw new Error('rig');
    expect(await custAuth.check(si.identity, use)).toBe('SIGNER_NOT_TRUSTED'); expect(await signAuth.check(ci.identity, use)).toBe('SIGNER_NOT_TRUSTED');
    // even when both roles are configured under the SAME workload id, an identity of one role is not accepted by the other
    const same = (role: string) => wl(role, [B1], { workloadId: 'shared:d15' });
    const sA = createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', () => same('EVIDENCE_SIGNER')), environment: 'development', clock });
    const cA = createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', () => same('EVIDENCE_CUSTODIAN')), environment: 'development', clock, role: 'EVIDENCE_CUSTODIAN' });
    const s2 = await sA.resolve(); const c2 = await cA.resolve(); if (!s2.ok || !c2.ok) throw new Error('rig');
    expect(await cA.check(s2.identity, use)).toBe('SIGNER_NOT_TRUSTED'); expect(await sA.check(c2.identity, use)).toBe('SIGNER_NOT_TRUSTED');
    expect(await cA.check(c2.identity, use)).toBeNull(); expect(await sA.check(s2.identity, use)).toBeNull();
  });

  it('6. cross-tenant retrieval is denied: a foreign record is indistinguishable from a missing one and leaves a bounded ACCESS_DENIED event naming only the claimant', async () => {
    const ev = await mkEvidence({ subject: 'inv_6' }, B1); const id = randomUUID();
    expect((await svc.persist({ evidenceId: id, expected: exp(B1), evidence: ev })).ok).toBe(true);
    const foreign = await svc.retrieve({ evidenceId: id, ...exp(B2) });
    const missing = await svc.retrieve({ evidenceId: randomUUID(), ...exp(B2) });
    expect(foreign).toEqual({ ok: false, reason: 'NOT_FOUND' }); expect(missing).toEqual(foreign);
    const denied = await q("select evidence_id, business_id, reason_code from signed_evidence_events where event_type='ACCESS_DENIED'");
    expect(denied.length).toBeGreaterThanOrEqual(1); expect(denied.every(d => d.evidence_id === null && d.business_id === B2 && d.reason_code === 'CROSS_TENANT')).toBe(true);
    // no event of tenant B2 ever references tenant B1's record
    expect((await q('select count(*)::int n from signed_evidence_events e join signed_evidence_records r on r.evidence_id=e.evidence_id where e.business_id <> r.business_id'))[0]!.n).toBe(0);
    // a persist whose expected business differs from the signed one never reaches the database
    expect(await svc.persist({ evidenceId: randomUUID(), expected: exp(B2), evidence: ev })).toEqual({ ok: false, reason: 'BINDING_MISMATCH' });
  });

  it('7. database privileges: ordinary, writer-only, reader-only and even the custodian logins cannot INSERT, UPDATE, DELETE or TRUNCATE; even the owner is bound by immutability', async () => {
    const plain = await connect('d15_plain'); const writer = await connect('d15_writer'); const reader = await connect('d15_reader'); const auditor = await connect('d15_auditor');
    const ins = `insert into signed_evidence_records(evidence_id,business_id,custodian_workload_id,signer_workload_id,environment,purpose,evidence_type,schema,schema_version,signed_at_ms,key_id,key_version,algorithm,payload_sha256,signature,payload_canonical,content_digest,persisted_by_db_role,created_at_ms) values (gen_random_uuid(),'${B1}','c','s','development','SYNTHETIC_TEST_EVIDENCE','SYNTHETIC_TEST_EVIDENCE','S08-SIGNED-EVIDENCE',1,1,'k',1,'Ed25519','${'0'.repeat(64)}','${'0'.repeat(128)}','{}','${'0'.repeat(64)}','x',1)`;
    for (const [name, c] of [['plain', plain], ['writer', writer], ['reader', reader], ['custodian', custodian], ['auditor', auditor]] as const) {
      for (const sqlText of [ins, "update signed_evidence_records set version = 1", 'delete from signed_evidence_records', 'truncate signed_evidence_records', "update signed_evidence_events set reason_code = 'X'", 'delete from signed_evidence_events', 'truncate signed_evidence_events']) {
        expect((await tryQ(c, sqlText)).error, `${name}: ${sqlText.slice(0, 40)}`).toMatch(/permission denied|row-level security/);
      }
    }
    for (const c of [plain, writer, reader, custodian]) { expect((await tryQ(c, 'select * from signed_evidence_records')).error).toMatch(/permission denied/); expect((await tryQ(c, 'select * from signed_evidence_events')).error).toMatch(/permission denied/); }
    expect((await tryQ(auditor, 'select count(*) from signed_evidence_records')).error).toBe(''); // read-only audit access
    // function authority is separated: the writer persists only, the reader fetches/records only, PUBLIC and plain logins execute nothing
    expect((await tryQ(reader, "select public.evidence_custody_persist(gen_random_uuid(),'c',gen_random_uuid(),'s','development','SYNTHETIC_TEST_EVIDENCE','SYNTHETIC_TEST_EVIDENCE','S08-SIGNED-EVIDENCE',1,1,'k',1,'Ed25519','','','{}')")).error).toMatch(/permission denied/);
    expect((await tryQ(writer, 'select * from public.evidence_custody_fetch(gen_random_uuid(), gen_random_uuid(), null)')).error).toMatch(/permission denied/);
    expect((await tryQ(plain, 'select * from public.evidence_custody_fetch(gen_random_uuid(), gen_random_uuid(), null)')).error).toMatch(/permission denied/);
    expect((await tryQ(writer, "select public.evidence_custody_note(null, gen_random_uuid(), 'ACCESS_DENIED', 'X', null)")).error).toMatch(/permission denied/);
    expect((await q("select count(*)::int n from pg_proc p where proname like 'evidence_custody_%' and has_function_privilege('public', p.oid, 'EXECUTE')"))[0]!.n).toBe(0);
    expect((await q("select count(*)::int n from pg_proc p where proname like 'evidence_custody_%' and prosecdef and (proowner::regrole::text <> 'signed_evidence_lifecycle' or proconfig is null or not proconfig::text like '%search_path=pg_catalog, public%')"))[0]!.n).toBe(0);
    // the superuser/owner is also bound by append-only triggers (ENABLE ALWAYS) and TRUNCATE denial
    expect((await tryQ(admin, 'update signed_evidence_records set version = 1')).error).toMatch(/SIGNED_EVIDENCE_APPEND_ONLY/);
    expect((await tryQ(admin, 'delete from signed_evidence_events')).error).toMatch(/SIGNED_EVIDENCE_APPEND_ONLY/);
    expect((await tryQ(admin, "update signed_evidence_events set reason_code = 'X'")).error).toMatch(/SIGNED_EVIDENCE_APPEND_ONLY/);
    expect((await tryQ(admin, 'delete from signed_evidence_records')).error).toMatch(/SIGNED_EVIDENCE_APPEND_ONLY/);
    expect((await tryQ(admin, 'truncate signed_evidence_records')).error).toMatch(/truncat/i);
    expect((await tryQ(admin, 'truncate signed_evidence_events')).error).toMatch(/truncat/i);
    // writer/reader/custodian logins cannot reach the activation policy
    for (const c of [writer, reader, custodian, plain]) { expect((await tryQ(c, 'update stripe_read_authorization_policy set approval_enabled = true')).error).toMatch(/permission denied/); }
    // the role the service switches to cannot be abused to escalate: SET ROLE to the owner role is not permitted
    expect((await tryQ(custodian, 'set role signed_evidence_lifecycle')).error).toMatch(/permission denied|must be member/);
  });

  it('8. concurrent identical writes store exactly one record; concurrent conflicting writes replace nothing', async () => {
    const conns = await Promise.all(Array.from({ length: 8 }, () => connect('d15_custodian'))); const svcs = conns.map(c => service(c));
    const ev = await mkEvidence({ subject: 'inv_8', c: 'same' }); const id = randomUUID();
    const same = await Promise.all(svcs.map(s => s.persist({ evidenceId: id, expected: exp(), evidence: ev })));
    expect(same.every(r => r.ok)).toBe(true); expect(same.filter(r => r.ok && r.outcome === 'PERSISTED')).toHaveLength(1); expect(same.filter(r => r.ok && r.outcome === 'REPLAYED')).toHaveLength(7);
    expect((await q('select count(*)::int n from signed_evidence_records where evidence_id=$1', [id]))[0]!.n).toBe(1);
    // conflicting: one id, eight different signed contents
    const id2 = randomUUID(); const variants = await Promise.all(Array.from({ length: 8 }, (_, i) => mkEvidence({ subject: 'inv_8', variant: i })));
    const race = await Promise.all(svcs.map((s, i) => s.persist({ evidenceId: id2, expected: exp(), evidence: variants[i]! })));
    expect(race.filter(r => r.ok)).toHaveLength(1); expect(race.filter(r => !r.ok && r.reason === 'EVIDENCE_CONFLICT')).toHaveLength(7);
    const winner = variants[race.findIndex(r => r.ok)]!;
    expect((await q('select signature from signed_evidence_records where evidence_id=$1', [id2])).map(r => r.signature)).toEqual([winner.signature]);
    // the same signed evidence under eight different ids: one record
    const ev3 = await mkEvidence({ subject: 'inv_8', c: 'sig' });
    const ids = await Promise.all(svcs.map(s => s.persist({ evidenceId: randomUUID(), expected: exp(), evidence: ev3 })));
    expect(ids.filter(r => r.ok)).toHaveLength(1); expect((await q('select count(*)::int n from signed_evidence_records where signature=$1', [ev3.signature]))[0]!.n).toBe(1);
  });

  it('9. a failing audit insert rolls back the storage; a failing verification record returns no evidence; recovery needs no cleanup', async () => {
    await q(`create function d15_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`);
    const ev = await mkEvidence({ subject: 'inv_9' }); const id = randomUUID();
    await q('create trigger d15_boom_events before insert on signed_evidence_events for each row execute function d15_boom()');
    try {
      const before = { r: await count('signed_evidence_records'), e: await count('signed_evidence_events') };
      expect(await svc.persist({ evidenceId: id, expected: exp(), evidence: ev })).toEqual({ ok: false, reason: 'STORE_UNAVAILABLE' });
      expect({ r: await count('signed_evidence_records'), e: await count('signed_evidence_events') }).toEqual(before); // no accepted-but-unaudited record
    } finally { await q('drop trigger d15_boom_events on signed_evidence_events'); }
    expect(await svc.persist({ evidenceId: id, expected: exp(), evidence: ev })).toMatchObject({ ok: true, outcome: 'PERSISTED' });
    await q("create trigger d15_boom_events before insert on signed_evidence_events for each row when (new.event_type like 'VERIFICATION%') execute function d15_boom()");
    try { expect(await svc.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'STORE_UNAVAILABLE' }); } // the verification could not be recorded, so nothing is returned
    finally { await q('drop trigger d15_boom_events on signed_evidence_events'); }
    expect(await svc.retrieve({ evidenceId: id, ...exp() })).toMatchObject({ ok: true });
    // a payload the database refuses (check constraint) fails closed and stores nothing
    const before = await count('signed_evidence_records');
    expect(await svc.persist({ evidenceId: randomUUID(), expected: exp(B1), evidence: { ...ev, claims: { ...ev.claims } } as SignedEvidence })).toMatchObject({ ok: false });
    expect(await count('signed_evidence_records')).toBe(before);
    await q('drop function d15_boom()');
  });

  it('10. key lifecycle on retrieval: rotation, retired-key policy, revocation, unavailable directory and clock boundaries, each recorded as a custody event', async () => {
    const ev = await mkEvidence({ subject: 'inv_10' }); const id = randomUUID();
    expect((await svc.persist({ evidenceId: id, expected: exp(), evidence: ev })).ok).toBe(true);
    const k2 = await syntheticKey({ keyId: 'k-v2', version: 2 });
    state.dir = [{ ...k1.record, state: 'RETIRED', retiredAtMs: 600_000 } as EvidenceKeyRecord, k2.record]; state.now = 700_000;
    expect(await svc.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'KEY_RETIRED_NOT_ACCEPTED' }); // nothing approved: ambiguous key state rejects
    const accepting = service(custodian, { policy: { retiredKeys: 'ACCEPT_WITHIN_RETENTION' } });
    expect(await accepting.retrieve({ evidenceId: id, ...exp() })).toMatchObject({ ok: true, keyState: 'RETIRED', financialAuthorization: 'NOT_GRANTED' });
    state.now = 2_000_000; state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2], { expiresAtMs: 9_000_000 }); // past the retention deadline
    expect(await accepting.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'KEY_RETENTION_EXPIRED' });
    state.now = 700_000;
    state.dir = [{ ...k1.record, state: 'REVOKED', revokedAtMs: 650_000 } as EvidenceKeyRecord, k2.record];
    expect(await accepting.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'KEY_REVOKED' }); // revoked: never, under any policy
    state.dir = 'garbage'; expect(await accepting.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'KEYS_UNAVAILABLE' });
    state.dir = [k2.record]; expect(await accepting.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'KEY_UNKNOWN' });
    state.dir = [k1.record]; state.now = 500_000; state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2]);
    const types = (await q("select event_type, reason_code from signed_evidence_events where evidence_id=$1 and event_type not in ('EVIDENCE_PERSISTED','VERIFICATION_ATTEMPTED') order by seq", [id])).map(e => `${e.event_type}:${e.reason_code}`);
    expect(types).toEqual(['VERIFICATION_FAILED:KEY_RETIRED_NOT_ACCEPTED', 'VERIFICATION_SUCCEEDED:AUTHENTIC', 'VERIFICATION_FAILED:KEY_RETENTION_EXPIRED', 'KEY_REVOKED:KEY_REVOKED', 'KEY_UNAVAILABLE:KEYS_UNAVAILABLE', 'KEY_UNAVAILABLE:KEY_UNKNOWN']);
    expect(await svc.retrieve({ evidenceId: id, ...exp() })).toMatchObject({ ok: true }); // the original key state verifies again
    // the issuance-window boundary: at notAfter the key is, for verification, retired
    state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2], { expiresAtMs: 9_000_000 }); state.now = k1.record.notAfterMs; expect(await svc.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'KEY_RETIRED_NOT_ACCEPTED' }); state.now = 500_000; state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2]);
  });

  it('11. a record altered or forged in the database by a privileged actor is detected on retrieval, because authenticity never rests on the database', async () => {
    const ev = await mkEvidence({ subject: 'inv_11' }); const id = randomUUID();
    expect((await svc.persist({ evidenceId: id, expected: exp(), evidence: ev })).ok).toBe(true);
    // 1) tamper with a stored row (owner disables the immutability trigger: the documented residual risk) -> the stored digest no longer matches
    await q('alter table signed_evidence_records disable trigger signed_evidence_records_no_update_delete');
    await q("update signed_evidence_records set payload_canonical = '{\"subject\":\"inv_x\"}', payload_sha256 = encode(sha256(convert_to('{\"subject\":\"inv_x\"}','UTF8')),'hex') where evidence_id=$1", [id]);
    await q('alter table signed_evidence_records enable always trigger signed_evidence_records_no_update_delete');
    expect(await svc.retrieve({ evidenceId: id, ...exp() })).toEqual({ ok: false, reason: 'CUSTODY_RECORD_INCONSISTENT' });
    // 2) a record inserted through the owning role with a FORGED signature gets a valid database digest but fails signature verification
    const forged = randomUUID();
    await q('set role signed_evidence_lifecycle');
    try {
      await q(`insert into signed_evidence_records(evidence_id,business_id,custodian_workload_id,signer_workload_id,environment,purpose,evidence_type,schema,schema_version,signed_at_ms,key_id,key_version,algorithm,payload_sha256,signature,payload_canonical,content_digest,persisted_by_db_role,created_at_ms)
        values ($1,$2,'custodian:d15','signer:d15','development','SYNTHETIC_TEST_EVIDENCE','SYNTHETIC_TEST_EVIDENCE','S08-SIGNED-EVIDENCE',1,500000,'k-v1',1,'Ed25519',encode(sha256(convert_to('{"a":1}','UTF8')),'hex'),$3,'{"a":1}','0','x',1)`, [forged, B1, 'ab'.repeat(64)]);
    } finally { await q('reset role'); }
    expect(await svc.retrieve({ evidenceId: forged, ...exp() })).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect((await q("select reason_code from signed_evidence_events where evidence_id=$1 and event_type='VERIFICATION_FAILED' order by seq", [forged])).map(e => e.reason_code)).toEqual(['SIGNATURE_INVALID']);
  });

  it('11b. even the owning definer role cannot attach an event to another tenant\'s record', async () => {
    const id = (await q('select evidence_id from signed_evidence_records where business_id=$1 limit 1', [B1]))[0]!.evidence_id;
    await q('set role signed_evidence_lifecycle');
    try {
      const ins = (biz: string) => tryQ(admin, "insert into signed_evidence_events(evidence_id,business_id,event_type,reason_code,actor_workload_id,at_ms,actor_db_role,record_digest) values ($1,$2,'ACCESS_DENIED','X',null,1,'x',$3)", [id, biz, '0'.repeat(64)]);
      expect((await ins(B2)).error).toMatch(/SIGNED_EVIDENCE_EVENT_TENANT/);
      expect((await ins(B1)).error).toBe('');
    } finally { await q('reset role'); }
  });

  it('12. malformed runtime input is rejected without throwing and without touching the store', async () => {
    const before = { r: await count('signed_evidence_records'), e: await count('signed_evidence_events') };
    const ev = await mkEvidence({ subject: 'inv_12' });
    for (const bad of [null, undefined, 1, 'x', [], {}, { evidenceId: 'nope', expected: exp(), evidence: ev }, { evidenceId: randomUUID(), expected: { businessId: B1 }, evidence: ev }, { evidenceId: randomUUID(), expected: { ...exp(), extra: 1 }, evidence: ev },
      { evidenceId: randomUUID(), expected: { ...exp(), purpose: 'SETTLEMENT_APPROVAL' }, evidence: ev }, { evidenceId: randomUUID(), expected: exp(), evidence: ev, extra: 1 }, { evidenceId: randomUUID(), expected: exp() }]) {
      expect(await svc.persist(bad as any)).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
    }
    for (const bad of [null, {}, { evidenceId: 'x', ...exp() }, { evidenceId: randomUUID(), businessId: B1 }, { evidenceId: randomUUID(), ...exp(), extra: 1 }]) expect(await svc.retrieve(bad as any)).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
    expect({ r: await count('signed_evidence_records'), e: await count('signed_evidence_events') }).toEqual(before);
  });

  it('12b. issued read capability retrieves real PostgreSQL custody only while the trusted workload remains authorized', async () => {
    state.now = 500_000;
    state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2]);
    const evidenceId = randomUUID();
    const signed = await mkEvidence({ subject: 'r1-custody-postgres' });
    expect(await svc.persist({ evidenceId, expected: exp(), evidence: signed })).toMatchObject({ ok: true, outcome: 'PERSISTED' });

    const reader = svc.issueTrustedReader();
    expect(isIssuedCustodyReader(reader)).toBe(true);
    expect(isIssuedCustodyReader({ ...reader })).toBe(false);
    expect(isIssuedCustodyReader(new Proxy(reader, {}))).toBe(false);
    const real = await reader.retrieve({ evidenceId, ...exp() });
    expect(real).toMatchObject({
      ok: true, evidenceId, authenticity: 'AUTHENTIC',
      financialAuthorization: 'NOT_GRANTED', payload: { subject: 'r1-custody-postgres' },
    });
    expect((await q("select count(*)::int n from signed_evidence_events where evidence_id=$1 and event_type='VERIFICATION_SUCCEEDED'", [evidenceId]))[0]!.n).toBe(1);

    // An issued capability is NOT a bypass of the runtime custodian authority.
    state.custWl = null;
    try {
      expect(await reader.retrieve({ evidenceId, ...exp() })).toMatchObject({ ok: false, reason: 'SIGNER_CONFIG_MISSING' });
    } finally { state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2]); }
    const again = await reader.retrieve({ evidenceId, ...exp() });
    expect(again).toMatchObject({ ok: true, financialAuthorization: 'NOT_GRANTED' });
  });

  it('DEV-19: PostgreSQL-backed signed evidence reaches only a trusted synthetic handoff, with no accounting authority', async () => {
    state.now = 500_000;
    state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2]);
    const evidenceId = randomUUID();
    const payload = { settlementEvidence: {
      provenance: { evidenceKind: 'MOCK_SYNTHETIC', snapshotRef: 'dev19-synthetic' },
      binding: { businessId: B1, reservationId: 'synthetic-res-1', intentRef: 'synthetic-intent-1' },
    } };
    const signed = await mkEvidence(payload);
    expect(await svc.persist({ evidenceId, expected: exp(), evidence: signed })).toMatchObject({ ok: true, outcome: 'PERSISTED' });

    const calls: Array<Record<string, unknown>> = [];
    // A recording spy is deliberate: setting up persisted reservation/intent/
    // allocation/subscription authority requires a separately isolated full
    // recorder fixture. This test proves custody->handoff, not D4 readiness.
    const recorder = {
      record: async (input: Record<string, any>) => {
        calls.push(input);
        return { id: randomUUID(), verdict: 'UNRESOLVED' as const, reasonCodes: ['INPUT_INVALID'], replay: false };
      },
    };
    const reader = svc.issueTrustedReader();
    const handoff = createSyntheticCustodyRecorderHandoff({ custody: reader, recorder });
    const req = { evidenceId, businessId: B1, reservationId: 'synthetic-res-1' };
    const result = await handoff.record(req);
    expect(result).toMatchObject({ ok: true, verdict: 'UNRESOLVED', financialAuthorization: 'NOT_GRANTED' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ businessId: B1, reservationId: req.reservationId, evidence: payload.settlementEvidence });
    const audit = await q("select event_type from signed_evidence_events where evidence_id=$1 order by seq", [evidenceId]);
    expect(audit.map(e => e.event_type)).toEqual(['EVIDENCE_PERSISTED', 'VERIFICATION_ATTEMPTED', 'VERIFICATION_SUCCEEDED']);

    // An object that merely mimics the same interface cannot cause a recorder call.
    const forged = createSyntheticCustodyRecorderHandoff({
      custody: { retrieve: async () => ({
        ok: true as const, authenticity: 'AUTHENTIC' as const, financialAuthorization: 'NOT_GRANTED' as const,
        claims: signed.claims, payload,
      }) },
      recorder,
    });
    expect(await forged.record(req)).toEqual({ ok: false, reason: 'CUSTODY_NOT_TRUSTED', financialAuthorization: 'NOT_GRANTED' });
    expect(calls).toHaveLength(1);

    // Revoking the trusted workload after reader issuance still fails closed.
    state.custWl = null;
    try {
      expect(await handoff.record(req)).toEqual({ ok: false, reason: 'CUSTODY_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED' });
      expect(calls).toHaveLength(1);
    } finally { state.custWl = wl('EVIDENCE_CUSTODIAN', [B1, B2]); }

    // Tenant/reservation substitution is rejected by the custody and handoff
    // boundaries before any settlement recorder call.
    const foreignTenant = await handoff.record({ ...req, businessId: B2 });
    expect(foreignTenant).toEqual({ ok: false, reason: 'CUSTODY_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED' });
    expect(await handoff.record({ ...req, reservationId: 'wrong-reservation' })).toEqual({
      ok: false, reason: 'BINDING_MISMATCH', financialAuthorization: 'NOT_GRANTED',
    });
    expect(calls).toHaveLength(1);

    // Key revocation is evaluated on every read, including through an
    // already-issued capability. A signed record is not perpetual authority.
    const activeDirectory = state.dir;
    state.dir = [{ ...k1.record, state: 'REVOKED', revokedAtMs: 499_000 } as EvidenceKeyRecord];
    try {
      expect(await handoff.record(req)).toEqual({
        ok: false, reason: 'CUSTODY_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED',
      });
      expect(calls).toHaveLength(1);
    } finally { state.dir = activeDirectory; }

    // Identical signed evidence remains retrievable but never supplies a
    // caller-chosen financial authorization or bypasses recorder verdicts.
    expect(await svc.persist({ evidenceId, expected: exp(), evidence: signed })).toMatchObject({
      ok: true, outcome: 'REPLAYED', financialAuthorization: 'NOT_GRANTED',
    });
    expect(await handoff.record(req)).toMatchObject({ ok: true, verdict: 'UNRESOLVED', financialAuthorization: 'NOT_GRANTED' });
    expect(calls).toHaveLength(2);

    // A real recorder WITHOUT trusted signer/config is never an authority;
    // the handoff must not turn the signed custody result into a persisted row.
    const unconfigured = new SettlementAuthorizationRecorder(buildDb(custodian), null as any);
    const inert = createSyntheticCustodyRecorderHandoff({ custody: reader, recorder: unconfigured });
    expect(await inert.record(req)).toEqual({ ok: false, reason: 'RECORDER_UNAVAILABLE', financialAuthorization: 'NOT_GRANTED' });
    expect(await policyRow()).toEqual(policyBefore);
  });

  it('13. the activation and financial boundaries are untouched: policy unchanged, no ledger or Stripe effect, evidence never presented as financial authority', async () => {
    expect(await policyRow()).toEqual(policyBefore); expect(policyBefore.approval_enabled).toBe(false);
    expect((await q("select count(*)::int n from pg_depend d join pg_proc p on p.oid=d.objid where p.proname like 'evidence_custody_%' and d.refobjid in ('partner_credit_ledger'::regclass, 'stripe_read_authorization_policy'::regclass)"))[0]!.n).toBe(0);
    expect((await q("select count(*)::int n from pg_trigger t where not t.tgisinternal and t.tgrelid in ('partner_credit_ledger'::regclass, 'stripe_read_authorization_policy'::regclass) and t.tgfoid::regproc::text like '%signed_evidence%'"))[0]!.n).toBe(0);
    const r = await svc.retrieve({ evidenceId: (await q('select evidence_id from signed_evidence_records limit 1'))[0]!.evidence_id, ...exp() });
    expect(r).toMatchObject({ ok: true, financialAuthorization: 'NOT_GRANTED' });
    expect(JSON.stringify(r)).not.toMatch(/"(eligible|eligibility|approved|authorized|consumable)"/i);
  });
});
