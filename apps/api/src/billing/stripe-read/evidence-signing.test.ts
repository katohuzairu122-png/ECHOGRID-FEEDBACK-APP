/* eslint-disable @typescript-eslint/no-explicit-any -- forgery tests deliberately build malformed objects */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createEvidenceSigningBoundary, createEvidenceVerifier, createSigningWorkloadAuthority, createWorkloadAuthority, createUnprovisionedKeyDirectory, createUnprovisionedSignerProvider,
  createUnprovisionedSigningWorkloadSource, isSigningWorkloadIdentity, parseKeyDirectory, resolveVerificationPolicy,
  type EvidenceKeyRecord, type EvidenceSigner, type ExpectedEvidence, type SignedEvidence,
} from './index';
import { randomBusinessId, syntheticDirectory, syntheticKey, syntheticSignerProvider, syntheticSigningWorkloadSource, type SyntheticKey } from './evidence-signing-test-support';

/**
 * S08-D1D3-DEV-14 (unit): trusted signing workload identity, signing-key configuration, the evidence signing boundary and the strict verifier. Everything is synthetic and in memory: disposable Ed25519 keys,
 * a test-only identity source, an injected clock. Nothing here contacts Stripe, a database or any key-management provider.
 */
const BIZ = randomBusinessId(); const OTHER = randomBusinessId();
const T0 = 500_000;
const WORKLOAD = 'signer:dev14-synthetic';
const REQ = (over: Record<string, unknown> = {}) => ({ businessId: BIZ, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', payload: { subject: 'inv_1', amountMinor: 1200, currency: 'usd' }, ...over }) as any;
const EXPECT: ExpectedEvidence = { businessId: BIZ, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', environment: 'development' };
afterEach(() => vi.restoreAllMocks());

async function rig(opts: { keys?: SyntheticKey[]; policy?: unknown; workload?: Record<string, unknown> | null; env?: 'development' | 'staging' } = {}) {
  const state = { now: T0, dir: null as unknown, wl: null as unknown };
  const keys = opts.keys ?? [await syntheticKey({ keyId: 'k-v1' })];
  state.dir = keys.map(k => k.record);
  state.wl = opts.workload === undefined ? { workloadId: WORKLOAD, role: 'EVIDENCE_SIGNER', environment: 'development', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: [BIZ], validFromMs: 1_000, expiresAtMs: 900_000, revokedAtMs: null } : opts.workload;
  const clock = () => state.now;
  const environment = opts.env ?? 'development';
  const authority = createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource(environment, () => state.wl), environment, clock });
  const dir = syntheticDirectory(() => state.dir);
  const providerKeys = [...keys];
  const boundary = createEvidenceSigningBoundary({ authority, keys: dir, signers: syntheticSignerProvider(providerKeys), environment, clock });
  const verifier = (policy?: unknown) => createEvidenceVerifier({ keys: dir, policy: policy ?? opts.policy, clock });
  return { state, keys, boundary, authority, verifier, dir, providerKeys, setKeys: (ks: SyntheticKey[]) => { providerKeys.splice(0, providerKeys.length, ...ks); state.dir = ks.map(k => k.record); } };
}
const sign = async (r: Awaited<ReturnType<typeof rig>>, req = REQ()) => { const x = await r.boundary.sign(req); if (!x.ok) throw new Error(`sign failed: ${x.reason}`); return x; };
const clone = (e: SignedEvidence, f: (c: any) => void): any => { const c = JSON.parse(JSON.stringify(e)); f(c); return c; };

describe('DEV-14 trusted signing workload', () => {
  it('1. an authorized synthetic workload signs, and the evidence verifies as AUTHENTIC with NO financial authorization', async () => {
    const r = await rig();
    const s = await sign(r);
    expect(s.metadata).toEqual({ keyId: 'k-v1', keyVersion: 1, algorithm: 'Ed25519', environment: 'development' });
    expect(s.evidence.claims).toMatchObject({ workloadId: WORKLOAD, businessId: BIZ, purpose: 'SYNTHETIC_TEST_EVIDENCE', schema: 'S08-SIGNED-EVIDENCE', schemaVersion: 1, signedAtMs: T0 });
    const v = await r.verifier().verify(s.evidence, EXPECT);
    expect(v).toMatchObject({ ok: true, authenticity: 'AUTHENTIC', financialAuthorization: 'NOT_GRANTED', keyState: 'ACTIVE' });
    expect(Object.keys(v)).not.toContain('eligible'); // authenticity is not provider verification and not authorization
  });

  it('2. unknown, unprovisioned or malformed workload configuration is rejected (fail closed)', async () => {
    expect(await (await rig({ workload: null })).boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNER_CONFIG_MISSING' });
    for (const source of [undefined, null, {} as any]) expect(await createSigningWorkloadAuthority({ source, environment: 'development', clock: () => T0 }).resolve()).toEqual({ ok: false, reason: 'SIGNER_CONFIG_MISSING' });
    const prod = createSigningWorkloadAuthority({ source: createUnprovisionedSigningWorkloadSource(), environment: 'production', clock: () => T0 }); // the production adapter is disabled
    expect(await prod.resolve()).toEqual({ ok: false, reason: 'SIGNER_CONFIG_MISSING' });
    for (const bad of [{}, [], 'x', { workloadId: WORKLOAD }, { workloadId: WORKLOAD, role: 'READER', environment: 'development', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: [BIZ], validFromMs: 1, expiresAtMs: 9, revokedAtMs: null },
      { workloadId: WORKLOAD, role: 'EVIDENCE_SIGNER', environment: 'development', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: [], validFromMs: 1, expiresAtMs: 9, revokedAtMs: null }, // no wildcard tenant
      { workloadId: WORKLOAD, role: 'EVIDENCE_SIGNER', environment: 'development', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: ['*'], validFromMs: 1, expiresAtMs: 9, revokedAtMs: null },
      { workloadId: WORKLOAD, role: 'EVIDENCE_SIGNER', environment: 'production', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: [BIZ], validFromMs: 1, expiresAtMs: 9, revokedAtMs: null }, // synthetic evidence never in production
      { workloadId: WORKLOAD, role: 'EVIDENCE_SIGNER', environment: 'development', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: [BIZ], validFromMs: 1, expiresAtMs: 9, revokedAtMs: null, extra: 1 }]) {
      expect((await (await rig({ workload: bad as any })).boundary.sign(REQ())).ok).toBe(false);
    }
    const throwing = createSigningWorkloadAuthority({ source: { load: async () => { throw new Error('boom'); } }, environment: 'development', clock: () => T0 });
    expect(await throwing.resolve()).toEqual({ ok: false, reason: 'SIGNER_CONFIG_UNAVAILABLE' });
  });

  it('3. a forged identity is rejected: no identity parameter exists, look-alikes and DEV-11 read-workload identities are not signers', async () => {
    const r = await rig();
    expect(await r.boundary.sign(REQ({ workload: { workloadId: WORKLOAD }, workloadId: WORKLOAD }))).toEqual({ ok: false, reason: 'INVALID_REQUEST' }); // strict request
    expect(await r.boundary.sign(REQ({ keyId: 'k-v1' }))).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
    const use = { environment: 'development', purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', businessId: BIZ };
    const real = await r.authority.resolve(); if (!real.ok) throw new Error('rig');
    expect(await r.authority.check(real.identity, use)).toBeNull();
    for (const fake of [{ ...real.identity }, Object.create(real.identity), JSON.parse(JSON.stringify(real.identity)), null, undefined, 'x', WORKLOAD]) {
      expect(isSigningWorkloadIdentity(fake)).toBe(false);
      expect(await r.authority.check(fake, use)).toBe('SIGNER_NOT_TRUSTED');
    }
    const readAuthority = createWorkloadAuthority({ environment: 'development', clock: () => T0, source: { load: async () => ({ workloadId: WORKLOAD, environment: 'development', accountId: 'acct_X1', realm: 'test', methods: ['ACCOUNT_RETRIEVE_CURRENT'], credentialRef: 'cred:x', signingKeyPurpose: 'SYNTHETIC_RUNTIME', validFromMs: 1, expiresAtMs: 900_000, revokedAtMs: null }) } });
    const rd = await readAuthority.resolve(); if (!rd.ok) throw new Error('rig');
    expect(await r.authority.check(rd.identity, use)).toBe('SIGNER_NOT_TRUSTED'); // a read workload cannot sign
  });

  it('4-5. expired, not-yet-valid and revoked workloads are rejected on the very next request', async () => {
    const r = await rig();
    await sign(r);
    r.state.now = 900_000; expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNER_EXPIRED' });
    r.state.now = 500; expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNER_NOT_YET_VALID' });
    r.state.now = T0; await sign(r);
    (r.state.wl as any).revokedAtMs = T0; expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNER_REVOKED' });
  });

  it('6. a signing workload from another environment is rejected', async () => {
    const r = await rig({ workload: { workloadId: WORKLOAD, role: 'EVIDENCE_SIGNER', environment: 'staging', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: [BIZ], validFromMs: 1_000, expiresAtMs: 900_000, revokedAtMs: null } });
    expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNER_WRONG_ENVIRONMENT' });
    expect(() => syntheticSigningWorkloadSource('production', () => null)).toThrow('TEST_IDENTITY_PROVIDER_REFUSED_IN_PRODUCTION'); // the test provider cannot exist in production
  });

  it('7. a wrong purpose or evidence type is rejected', async () => {
    const r = await rig();
    expect(await r.boundary.sign(REQ({ purpose: 'STRIPE_OBSERVATION_ATTESTATION', evidenceType: 'STRIPE_INVOICE_OBSERVATION' }))).toEqual({ ok: false, reason: 'SIGNER_PURPOSE_NOT_PERMITTED' });
    expect(await r.boundary.sign(REQ({ evidenceType: 'STRIPE_INVOICE_OBSERVATION' }))).toEqual({ ok: false, reason: 'INVALID_REQUEST' }); // type not defined for the purpose
    expect(await r.boundary.sign(REQ({ purpose: 'SETTLEMENT_APPROVAL' }))).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
  });

  it('8. cross-tenant substitution is rejected at signing and at verification', async () => {
    const r = await rig();
    expect(await r.boundary.sign(REQ({ businessId: OTHER }))).toEqual({ ok: false, reason: 'SIGNER_TENANT_NOT_PERMITTED' });
    const { evidence } = await sign(r);
    expect(await r.verifier().verify(evidence, { ...EXPECT, businessId: OTHER })).toEqual({ ok: false, reason: 'BINDING_MISMATCH' });
    const swapped = clone(evidence, c => { c.claims.businessId = OTHER; });
    expect(await r.verifier().verify(swapped, { ...EXPECT, businessId: OTHER })).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' }); // re-labelling a signature for another tenant fails
  });
});

describe('DEV-14 signing-key configuration and verification', () => {
  it('9. a missing, unavailable, malformed or unprovisioned key directory fails closed', async () => {
    const r = await rig();
    r.state.dir = [];
    expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
    r.state.dir = 'garbage'; expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
    r.state.dir = null; expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
    const r2 = await rig();
    const bad = createEvidenceSigningBoundary({ authority: r2.authority, keys: createUnprovisionedKeyDirectory(), signers: createUnprovisionedSignerProvider(), environment: 'development', clock: () => T0 });
    expect(await bad.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
    const noSigner = createEvidenceSigningBoundary({ authority: r2.authority, keys: r2.dir, signers: createUnprovisionedSignerProvider(), environment: 'development', clock: () => T0 });
    expect(await noSigner.sign(REQ())).toEqual({ ok: false, reason: 'SIGNER_UNAVAILABLE' });
    const { evidence } = await sign(r2);
    expect(await createEvidenceVerifier({ keys: createUnprovisionedKeyDirectory(), clock: () => T0 }).verify(evidence, EXPECT)).toEqual({ ok: false, reason: 'KEYS_UNAVAILABLE' });
  });

  it('10-11. a wrong key identifier, a wrong key version and an unsupported algorithm are rejected', async () => {
    const r = await rig({ keys: [await syntheticKey({ keyId: 'k-v1' }), await syntheticKey({ keyId: 'k-other', version: 2, state: 'RETIRED', retiredAtMs: 400_000 })] });
    const { evidence } = await sign(r);
    expect(await r.verifier().verify(clone(evidence, c => { c.claims.keyId = 'k-unknown'; }), EXPECT)).toEqual({ ok: false, reason: 'KEY_UNKNOWN' });
    expect(await r.verifier().verify(clone(evidence, c => { c.claims.keyVersion = 9; }), EXPECT)).toEqual({ ok: false, reason: 'KEY_VERSION_MISMATCH' });
    expect(await r.verifier().verify(clone(evidence, c => { c.claims.keyId = 'k-other'; c.claims.keyVersion = 2; }), EXPECT)).toMatchObject({ ok: false }); // another key never verifies this signature
    expect(await r.verifier().verify(clone(evidence, c => { c.claims.algorithm = 'HS256'; }), EXPECT)).toEqual({ ok: false, reason: 'ALGORITHM_UNSUPPORTED' });
    expect(await r.verifier().verify(clone(evidence, c => { c.claims.algorithm = 'none'; }), EXPECT)).toEqual({ ok: false, reason: 'ALGORITHM_UNSUPPORTED' });
    // a directory that lists an unsupported algorithm is untrusted as a whole
    r.state.dir = (r.state.dir as EvidenceKeyRecord[]).map(k => ({ ...k, algorithm: 'RS256' }));
    expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
    expect(await r.verifier().verify(evidence, EXPECT)).toEqual({ ok: false, reason: 'KEYS_UNAVAILABLE' });
  });

  it('12-13. an altered payload, an invalid signature, a malformed signature and a wrong schema version are rejected', async () => {
    const r = await rig(); const v = r.verifier();
    const { evidence } = await sign(r);
    expect(await v.verify(clone(evidence, c => { c.payload.amountMinor = 99_999; }), EXPECT)).toEqual({ ok: false, reason: 'PAYLOAD_TAMPERED' });
    expect(await v.verify(clone(evidence, c => { c.payload.extra = 1; }), EXPECT)).toEqual({ ok: false, reason: 'PAYLOAD_TAMPERED' });
    expect(await v.verify(clone(evidence, c => { c.signature = (c.signature[0] === 'a' ? 'b' : 'a') + c.signature.slice(1); }), EXPECT)).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(await v.verify(clone(evidence, c => { c.signature = '0'.repeat(128); }), EXPECT)).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(await v.verify(clone(evidence, c => { c.signature = 'abcd'; }), EXPECT)).toEqual({ ok: false, reason: 'EVIDENCE_MALFORMED' });
    expect(await v.verify(clone(evidence, c => { c.claims.schemaVersion = 2; }), EXPECT)).toEqual({ ok: false, reason: 'SCHEMA_MISMATCH' });
    expect(await v.verify(clone(evidence, c => { c.claims.schema = 'OTHER'; }), EXPECT)).toEqual({ ok: false, reason: 'SCHEMA_MISMATCH' });
    expect(await v.verify(clone(evidence, c => { c.claims.signedAtMs += 1; }), EXPECT)).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(await v.verify(clone(evidence, c => { c.claims.workloadId = 'signer:someone-else'; }), EXPECT)).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(await v.verify(clone(evidence, c => { c.claims.keyVersion += 0; c.claims.purpose = 'STRIPE_OBSERVATION_ATTESTATION'; c.claims.evidenceType = 'STRIPE_INVOICE_OBSERVATION'; }), { ...EXPECT, purpose: 'STRIPE_OBSERVATION_ATTESTATION', evidenceType: 'STRIPE_INVOICE_OBSERVATION' })).toEqual({ ok: false, reason: 'KEY_PURPOSE_MISMATCH' });
    expect(await v.verify(clone(evidence, c => { c.claims.environment = 'staging'; }), { ...EXPECT, environment: 'staging' })).toEqual({ ok: false, reason: 'KEY_ENVIRONMENT_MISMATCH' });
    expect(await v.verify(evidence, { ...EXPECT, evidenceType: 'STRIPE_INVOICE_OBSERVATION' })).toEqual({ ok: false, reason: 'BINDING_MISMATCH' });
    expect(await v.verify(evidence, { ...EXPECT, environment: 'production' })).toEqual({ ok: false, reason: 'BINDING_MISMATCH' });
    expect(await v.verify(clone(evidence, c => { c.claims.signedAtMs = T0 + 3_600_000; }), EXPECT)).toEqual({ ok: false, reason: 'SIGNED_IN_FUTURE' });
    expect(await v.verify(evidence, EXPECT)).toMatchObject({ ok: true }); // the untouched original still verifies
  });

  it('14. a caller-supplied verdict is never signed: signing cannot convert untrusted evidence into financial authorization', async () => {
    const r = await rig();
    for (const payload of [{ eligible: true }, { Eligibility: 'x' }, { nested: { approved: true } }, { list: [{ verdict: 'ok' }] }, { status: 'ELIGIBLE' }, { status: ' approved ' }, { 'approval_enabled': true }, { approvalEnabled: false }, { settlementStatus: 'x' }]) {
      expect(await r.boundary.sign(REQ({ payload }))).toEqual({ ok: false, reason: 'PAYLOAD_REJECTED' });
    }
  });

  it('15. key rotation: new evidence uses the newest ACTIVE version; old evidence follows the EXPLICIT verification policy', async () => {
    const v1 = await syntheticKey({ keyId: 'k-v1', version: 1 });
    const r = await rig({ keys: [v1] });
    const old = (await sign(r)).evidence; expect(old.claims.keyId).toBe('k-v1');
    // rotate: v1 is retired (it signed before retiredAtMs), v2 becomes ACTIVE
    const v2 = await syntheticKey({ keyId: 'k-v2', version: 2 });
    // keep v1's real key pair: rebuild a retired record around the same public key
    r.setKeys([{ ...v1, record: { ...v1.record, state: 'RETIRED', retiredAtMs: 600_000 } }, v2]);
    r.state.now = 700_000;
    const fresh = (await sign(r)).evidence; expect(fresh.claims).toMatchObject({ keyId: 'k-v2', keyVersion: 2 });
    // default policy (nothing approved): evidence depending on a retired key is rejected
    expect(await r.verifier().verify(old, EXPECT)).toEqual({ ok: false, reason: 'KEY_RETIRED_NOT_ACCEPTED' });
    for (const ambiguous of [undefined, null, {}, { retiredKeys: 'ACCEPT' }, { retiredKeys: 'accept_within_retention' }, 'ACCEPT_WITHIN_RETENTION', { retiredKeys: 'ACCEPT_WITHIN_RETENTION', x: 1 }]) {
      expect(await r.verifier(ambiguous).verify(old, EXPECT)).toEqual({ ok: false, reason: 'KEY_RETIRED_NOT_ACCEPTED' });
      expect(resolveVerificationPolicy(ambiguous)).toEqual({ retiredKeys: 'REJECT' });
    }
    // explicit policy: historical evidence verifies inside the retention deadline, and not after it
    const accept = { retiredKeys: 'ACCEPT_WITHIN_RETENTION' };
    expect(await r.verifier(accept).verify(old, EXPECT)).toMatchObject({ ok: true, keyState: 'RETIRED', financialAuthorization: 'NOT_GRANTED' });
    expect(await r.verifier(accept).verify(fresh, EXPECT)).toMatchObject({ ok: true, keyState: 'ACTIVE' });
    r.state.now = 2_000_000; expect(await r.verifier(accept).verify(old, EXPECT)).toEqual({ ok: false, reason: 'KEY_RETENTION_EXPIRED' });
    // a retired key signs nothing new, and evidence claiming to be signed after retirement is refused
    r.state.now = 700_000;
    expect(await r.verifier(accept).verify(clone(old, c => { c.claims.signedAtMs = 650_000; }), EXPECT)).toEqual({ ok: false, reason: 'SIGNED_OUTSIDE_KEY_WINDOW' });
    // an ACTIVE key past its issuance window is, for verification, a retired key
    r.setKeys([v1, v2]); r.state.now = 1_500_000; (r.state.wl as any).expiresAtMs = 5_000_000;
    expect(await r.verifier().verify(old, EXPECT)).toEqual({ ok: false, reason: 'KEY_RETIRED_NOT_ACCEPTED' });
    expect(await r.verifier(accept).verify(old, EXPECT)).toMatchObject({ ok: true, keyState: 'RETIRED' });
    expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' }); // and neither key signs outside its window
  });

  it('15b. evidence signed outside the key issuance window is refused even though the signature is genuine', async () => {
    const k = await syntheticKey({ keyId: 'k-v1' });
    const r = await rig({ keys: [k] });
    const ev = (await sign(r)).evidence; // signed at T0 inside [1_000, 1_000_000)
    const accept = { retiredKeys: 'ACCEPT_WITHIN_RETENTION' };
    r.setKeys([{ ...k, record: { ...k.record, notAfterMs: T0 } }]); r.state.now = T0 + 10; // the window now ends exactly when the evidence claims to have been signed
    expect(await r.verifier(accept).verify(ev, EXPECT)).toEqual({ ok: false, reason: 'SIGNED_OUTSIDE_KEY_WINDOW' });
    r.setKeys([{ ...k, record: { ...k.record, notBeforeMs: T0 + 1 } }]);
    expect(await r.verifier(accept).verify(ev, EXPECT)).toEqual({ ok: false, reason: 'SIGNED_OUTSIDE_KEY_WINDOW' });
    r.setKeys([k]); expect(await r.verifier().verify(ev, EXPECT)).toMatchObject({ ok: true });
  });

  it('16. a revoked key is rejected under EVERY policy, and stops signing at once', async () => {
    const k = await syntheticKey({ keyId: 'k-v1' });
    const r = await rig({ keys: [k] });
    const ev = (await sign(r)).evidence;
    r.setKeys([{ ...k, record: { ...k.record, state: 'REVOKED', revokedAtMs: 520_000 } }]);
    for (const policy of [undefined, { retiredKeys: 'ACCEPT_WITHIN_RETENTION' }]) expect(await r.verifier(policy).verify(ev, EXPECT)).toEqual({ ok: false, reason: 'KEY_REVOKED' });
    expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
    r.setKeys([{ ...k, record: { ...k.record, state: 'PENDING' } }]);
    expect(await r.verifier().verify(ev, EXPECT)).toEqual({ ok: false, reason: 'KEY_NOT_ACTIVE' });
    expect(await r.boundary.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
  });

  it('17. the key directory is strict: contradictory, duplicate, extra, over-wide or production-synthetic records make the whole directory untrusted', async () => {
    const k = (await syntheticKey({ keyId: 'k-a' })).record;
    expect(parseKeyDirectory([k])).toHaveLength(1);
    const bad: unknown[] = [
      { ...k, state: 'ACTIVE', revokedAtMs: 5 }, { ...k, state: 'ACTIVE', retiredAtMs: 5 }, { ...k, state: 'RETIRED', retiredAtMs: null }, { ...k, state: 'REVOKED', revokedAtMs: null }, { ...k, state: 'PAUSED' },
      { ...k, algorithm: 'RS256' }, { ...k, purpose: 'ANYTHING' }, { ...k, environment: 'qa' }, { ...k, environment: 'production' }, // synthetic purpose in production
      { ...k, publicKeyHex: 'zz' }, { ...k, version: 0 }, { ...k, notAfterMs: k.notBeforeMs }, { ...k, verifyUntilMs: k.notAfterMs - 1 }, { ...k, keyId: '../x' }, { ...k, extra: 1 },
      (({ revokedAtMs: _r, ...rest }) => rest)(k),
    ];
    for (const b of bad) expect(parseKeyDirectory([b])).toBeNull();
    expect(parseKeyDirectory([k, { ...k, version: 2 }])).toBeNull(); // duplicate key id
    expect(parseKeyDirectory([k, { ...k, keyId: 'k-b' }])).toBeNull(); // duplicate (purpose, environment, version)
    expect(parseKeyDirectory([k, { ...k, keyId: 'k-b', environment: 'staging' }])).toHaveLength(2);
    expect(parseKeyDirectory(new Array(65).fill(k))).toBeNull();
    for (const x of [null, undefined, {}, 'x', 1]) expect(parseKeyDirectory(x)).toBeNull();
  });
});

describe('DEV-14 secrecy, malformed input, concurrency and the activation boundary', () => {
  it('18-19. private key material never appears in results, errors or logs, even when the provider fails with it in its message', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const k = await syntheticKey({ keyId: 'k-v1' });
    const secret = k.pkcs8Base64;
    const leaking: EvidenceSigner = { keyId: 'k-v1', sign: async () => { throw new Error(`HSM said ${secret}`); } };
    const r = await rig({ keys: [k] });
    const leakyBoundary = createEvidenceSigningBoundary({ authority: r.authority, keys: r.dir, signers: { signerFor: () => leaking }, environment: 'development', clock: () => T0 });
    const failed = await leakyBoundary.sign(REQ());
    expect(failed).toEqual({ ok: false, reason: 'SIGNING_FAILED' });
    const throwingProvider = createEvidenceSigningBoundary({ authority: r.authority, keys: r.dir, signers: { signerFor: () => { throw new Error(`oops ${secret}`); } }, environment: 'development', clock: () => T0 });
    expect(await throwingProvider.sign(REQ())).toEqual({ ok: false, reason: 'SIGNER_UNAVAILABLE' });
    const throwingDir = createEvidenceSigningBoundary({ authority: r.authority, keys: { load: async () => { throw new Error(`dir ${secret}`); } }, signers: syntheticSignerProvider([k]), environment: 'development', clock: () => T0 });
    expect(await throwingDir.sign(REQ())).toEqual({ ok: false, reason: 'SIGNING_KEY_UNAVAILABLE' });
    const ok = await sign(r);
    const everything = JSON.stringify([failed, ok, await r.verifier().verify(ok.evidence, EXPECT), await r.authority.resolve(), r.state.dir]) + logs.join('\n');
    const raw = Buffer.from(secret, 'base64');
    for (const needle of [secret, secret.slice(16, 40), raw.toString('hex'), raw.subarray(16).toString('hex')]) expect(everything).not.toContain(needle);
    // the public record carries a public key only; the signer exposes a capability, not bytes
    expect(Object.keys(k.record)).not.toEqual(expect.arrayContaining(['privateKey', 'pkcs8', 'secret']));
    expect(Object.keys(ok.metadata).sort()).toEqual(['algorithm', 'environment', 'keyId', 'keyVersion']);
    expect(Object.keys(ok.evidence).sort()).toEqual(['claims', 'payload', 'signature']);
  });

  it('20. a duplicate signing request has no financial or persistent effect: signing is pure, repeatable, and verification grants nothing', async () => {
    const r = await rig();
    const a = await sign(r); const b = await sign(r);
    expect(b.evidence).toEqual(a.evidence); // deterministic Ed25519 over a deterministic message
    expect(await r.verifier().verify(a.evidence, EXPECT)).toMatchObject({ ok: true, financialAuthorization: 'NOT_GRANTED' });
    expect(await r.verifier().verify(b.evidence, EXPECT)).toMatchObject({ ok: true, financialAuthorization: 'NOT_GRANTED' });
    r.state.now += 1; expect((await sign(r)).evidence.signature).not.toBe(a.evidence.signature); // a new signing time is a new, equally harmless attestation
  });

  it('21. malformed runtime inputs are rejected without throwing', async () => {
    const r = await rig(); const v = r.verifier();
    for (const bad of [null, undefined, 1, 'x', [], {}, { businessId: BIZ }, REQ({ businessId: 'not-a-uuid' }), REQ({ businessId: BIZ.toUpperCase() }), REQ({ purpose: undefined }), REQ({ evidenceType: 7 })]) {
      expect((await r.boundary.sign(bad as any)).ok).toBe(false);
    }
    const deep: any = {}; let cur = deep; for (let i = 0; i < 12; i++) { cur.n = {}; cur = cur.n; }
    class Evil { x = 1; }
    for (const payload of [null, [], 'x', 1, deep, { big: 'x'.repeat(70_000) }, { n: NaN }, { n: Infinity }, { f: () => 1 }, { u: undefined }, { b: BigInt(1) }, new Evil(), JSON.parse('{"__proto__": {"a": 1}}')]) {
      expect(await r.boundary.sign(REQ({ payload }))).toEqual({ ok: false, reason: 'PAYLOAD_REJECTED' });
    }
    for (const bad of [null, undefined, 1, 'x', [], {}, { claims: {}, payload: {}, signature: '' }, { claims: null, payload: {}, signature: 'a'.repeat(128) }]) {
      expect(await v.verify(bad, EXPECT)).toEqual({ ok: false, reason: 'EVIDENCE_MALFORMED' });
    }
    const { evidence } = await sign(r);
    expect(await v.verify(evidence, null as any)).toEqual({ ok: false, reason: 'BINDING_MISMATCH' });
    expect(await v.verify({ ...evidence, extra: 1 }, EXPECT)).toEqual({ ok: false, reason: 'EVIDENCE_MALFORMED' });
  });

  it('22. concurrent and repeated signing and verification are consistent; revocation takes effect for the next request', async () => {
    const r = await rig(); const v = r.verifier();
    const signed = await Promise.all(Array.from({ length: 40 }, () => r.boundary.sign(REQ())));
    expect(signed.every(s => s.ok)).toBe(true);
    const ev = (signed[0] as any).evidence as SignedEvidence;
    expect(new Set(signed.map(s => (s as any).evidence.signature)).size).toBe(1);
    const verified = await Promise.all(Array.from({ length: 40 }, () => v.verify(ev, EXPECT)));
    expect(verified.every(x => x.ok)).toBe(true);
    (r.state.wl as any).revokedAtMs = T0;
    const after = await Promise.all(Array.from({ length: 10 }, () => r.boundary.sign(REQ())));
    expect(after.every(x => !x.ok && x.reason === 'SIGNER_REVOKED')).toBe(true);
    expect(await v.verify(ev, EXPECT)).toMatchObject({ ok: true }); // revoking the workload does not invalidate authentic historical evidence; revoking the KEY does
  });

  it('23. DEV-14 cannot reach or change the activation boundary, the database, Stripe, the environment or any API', () => {
    const dir = resolve(__dirname);
    const mine = ['evidence-signing.ts', 'evidence-signing-keys.ts', 'evidence-signing-workload.ts', 'evidence-signing-test-support.ts'];
    for (const f of mine) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/approval_enabled|stripe_read_authorization_policy|policy-activation|policy-administration|activatePolicy|OwnerActivationAuthority/);
      expect(src, f).not.toMatch(/process\.env|\bfetch\(|https?:\/\/|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|drizzle|\bsql`/);
      // the only modules these files may import: each other, canonical JSON/hash, the key/workload types and (tests only) node:crypto and the DEV-10 signer
      const allowed = ['./bundle-builder', './evidence-signing-keys', './evidence-signing-workload', './workload-identity', './trusted-runtime', 'node:crypto'];
      for (const m of src.matchAll(/from '([^']+)'/g)) expect(allowed, `${f} imports ${m[1]}`).toContain(m[1]);
    }
    // the sealed DEV-13 activation contract is untouched: it still has no designated authority and still always refuses
    const act = readFileSync(join(dir, 'policy-activation.ts'), 'utf8');
    expect(act).toContain('ACTIVATION_NOT_IMPLEMENTED'); expect(act).toContain('AUTHORITY_NOT_DESIGNATED'); expect(act).not.toMatch(/designated\.add\(/);
    // the test-only provider is not exported and is imported by tests only
    expect(readFileSync(join(dir, 'index.ts'), 'utf8')).not.toContain('evidence-signing-test-support');
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
    for (const f of walk(resolve(dir, '../../..', 'src'))) {
      if (f.endsWith('.test.ts') || f.endsWith('evidence-signing-test-support.ts')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toContain('evidence-signing-test-support');
    }
  });

  it('24. no HTTP/API surface can reach signing or key material: no route, middleware or handler imports the signing modules', () => {
    const srcRoot = resolve(__dirname, '../../..', 'src');
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
    const importers = walk(srcRoot).filter(f => /from '[^']*evidence-signing(-keys|-workload)?'|from '[^']*stripe-read'|from '[^']*stripe-read\/index'/.test(readFileSync(f, 'utf8')) && /evidence-signing|createEvidenceSigningBoundary|createSigningWorkloadAuthority/.test(readFileSync(f, 'utf8')));
    const unexpected = importers.filter(f => !/\/billing\/stripe-read\//.test(f));
    expect(unexpected).toEqual([]);
    const routes = walk(resolve(srcRoot, 'internal')).filter(f => !f.endsWith('.test.ts'));
    for (const f of routes) expect(readFileSync(f, 'utf8'), f).not.toMatch(/createEvidenceSigningBoundary|createSigningWorkloadAuthority|EvidenceSignerProvider|signerFor|pkcs8/);
  });
});
