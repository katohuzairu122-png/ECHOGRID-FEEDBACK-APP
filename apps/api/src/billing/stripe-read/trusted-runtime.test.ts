/* eslint-disable @typescript-eslint/no-explicit-any -- forgery tests deliberately build malformed and relabelled objects */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyProof, createInMemoryProofStore, createMockReadProvider, createObservationVerifier, createStripeGetTransport, createTrustedStripeRuntime, isIssuedObservation, MappingRegistry, observationMessage,
  OBSERVATION_CONTRACT_VERSION, ScriptedReadTransport, sealedOriginOf, type CredentialSource, type ExpectedBinding, type ObservationVerifier, type ReadAuditEvent, type SignedObservation, type TrustedReadRuntime,
} from './index';
import { captureProof } from './proof-capture';
import { createSyntheticTrustedRuntime } from './synthetic-runtime';
import { ACCT, API, account, AUTH, captureOver, gateFor, invoice, NOW, runtimeOver, syntheticTrust, WORKLOAD, type SyntheticTrust } from './pipeline-fixtures';

/**
 * S08-D1D3-DEV-10 trusted runtime boundary: authenticity comes from a signature by a trusted runtime key, never from a field an adapter, transport or provider reports. Every key here is a throwaway
 * generated for the test; nothing contacts Stripe (the real-runtime tests stub the global fetch).
 */
const GOOD_KEY = ['rk', 'test', 'SyntheticDev10Key0123456789'].join('_');
const cred = (): CredentialSource => ({ async resolve() { return { apiKey: GOOD_KEY, accountId: ACCT, workloadId: WORKLOAD, validUntilMs: NOW + 3_600_000 }; } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stubFetch = (handler: (url: string) => Response = u => (u.endsWith('/v1/account') ? json(account) : json(invoice()))) => {
  const calls: string[] = []; vi.stubGlobal('fetch', async (u: any) => { calls.push(String(u)); return handler(String(u)); }); return calls;
};
afterEach(() => vi.unstubAllGlobals());

const exp = (over: Partial<ExpectedBinding> = {}): ExpectedBinding => ({ kind: 'SYNTHETIC_RUNTIME', businessId: 'biz-1', accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', subject: 'in_1', apiVersion: API, ...over });
const REQ = { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE' as const, invoiceId: 'in_1', apiVersion: API, purpose: 'EVIDENCE' as const };
async function issue(over: { trust?: SyntheticTrust; gate?: ReturnType<typeof gateFor>; transport?: ScriptedReadTransport } = {}) {
  const transport = over.transport ?? new ScriptedReadTransport([account, invoice()]);
  const gate = over.gate ?? gateFor(AUTH);
  const rig = runtimeOver(transport, gate, () => NOW, over.trust);
  const out = await rig.runtime.read(REQ);
  if (!out.ok) throw new Error('issue failed ' + JSON.stringify(out));
  return { ...rig, transport, gate, observation: out.observation };
}
const cross = (rig: { trust: SyntheticTrust }, clock = () => NOW): ObservationVerifier => createObservationVerifier({ keyRing: rig.trust.keyRing, clock, crossProcess: true });

describe('24-26. a mock or synthetic source cannot become authentic-origin evidence', () => {
  it('24. a mock provider cannot claim REAL_NETWORK: mock evidence is sealed MOCK_FIXTURE, and a synthetic runtime observation never verifies as REAL_NETWORK', async () => {
    const mock = createMockReadProvider({ account, invoices: [invoice()] });
    expect(mock.kind).toBe('MOCK_FIXTURE'); expect('authenticity' in mock).toBe(false); expect('provenance' in mock).toBe(false);
    const rig = await issue();
    expect(rig.runtime.kind).toBe('SYNTHETIC_RUNTIME');
    expect(await rig.verifier.verify(rig.observation, exp({ kind: 'REAL_NETWORK' }))).toEqual({ ok: false, reason: 'KIND_MISMATCH' });
    expect(await rig.verifier.verify(rig.observation, exp())).toMatchObject({ ok: true, kind: 'SYNTHETIC_RUNTIME' });
    // a REAL_NETWORK claim made by relabelling the claims fails on the signature (cross-process view) ...
    const relabelled = { ...rig.observation, claims: { ...rig.observation.claims, kind: 'REAL_NETWORK' } };
    expect(await cross(rig).verify(relabelled, exp({ kind: 'REAL_NETWORK' }))).toMatchObject({ ok: false, reason: 'SIGNING_KEY_PURPOSE' }); // ... and the synthetic key is not a TRUSTED_RUNTIME key
    // the real runtime refuses to sign with a key the ring registers as synthetic, before any request
    const calls = stubFetch(); const syn = syntheticTrust('SYNTHETIC_RUNTIME');
    const real = createTrustedStripeRuntime({ signer: syn.signer, keyRing: syn.keyRing, gate: gateFor(AUTH), credentials: cred(), clock: () => NOW });
    expect(await real.read(REQ)).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_PURPOSE' }); expect(calls).toEqual([]);
    // and the synthetic runtime refuses a TRUSTED_RUNTIME key for the same reason in the other direction
    const tr = syntheticTrust('TRUSTED_RUNTIME');
    const synWithRealKey = createSyntheticTrustedRuntime({ signer: tr.signer, keyRing: tr.keyRing, gate: gateFor(AUTH), clock: () => NOW, transport: new ScriptedReadTransport([account, invoice()]) });
    expect(await synWithRealKey.read(REQ)).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_PURPOSE' });
    // mock evidence stays a distinct origin
    const { acquireEvidence } = await import('./evidence-engine');
    const out = await acquireEvidence({ provider: mock, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', invoiceId: 'in_1', customerId: 'cus_1', subscriptionId: 'sub_1' }, ACCT, null);
    if (out.ok) expect(sealedOriginOf(out.evidence)).toBe('MOCK_FIXTURE');
  });

  it('25. a forged networkSource is rejected: the field no longer exists and no value of it changes any origin', async () => {
    const t = new ScriptedReadTransport([account, invoice()]);
    for (const claim of ['GLOBAL_FETCH', 'REAL_NETWORK', 'INJECTED', true]) {
      const forged = Object.assign(t, { networkSource: claim }) as any;
      const store = createInMemoryProofStore();
      const cap = await captureOver({ transport: forged, gate: gateFor(AUTH, { mapping: MappingRegistry.catalog() }), store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1' });
      if (!cap.ok) throw new Error('capture');
      expect(cap.proof.captureOrigin, String(claim)).toBe('SYNTHETIC_RUNTIME'); expect(applyProof(MappingRegistry.catalog(), cap.proof)).toMatchObject({ note: 'ORIGIN_CANNOT_VERIFY', changes: [] });
    }
    // an adapter-supplied runtime object that merely says it is real produces observations nobody issued: refused by identity, and by signature in the cross-process view
    const rig = await issue();
    const lying: TrustedReadRuntime = { kind: 'REAL_NETWORK', workloadId: WORKLOAD, mapping: rig.runtime.mapping, async check() { return { ok: true }; },
      async read() { return { ok: true, observation: { claims: { ...rig.observation.claims, kind: 'REAL_NETWORK' }, body: account, signature: 'a'.repeat(128) } as unknown as SignedObservation }; } };
    const verifier = createObservationVerifier({ keyRing: rig.trust.keyRing, clock: () => NOW });
    const store = createInMemoryProofStore();
    expect(await captureProof({ runtime: lying, verifier, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' })).toEqual({ ok: false, kind: 'DENIED', reason: 'NOT_ISSUED_BY_RUNTIME' });
    expect(store.list()).toEqual([]);
    const xv = createObservationVerifier({ keyRing: rig.trust.keyRing, clock: () => NOW, crossProcess: true });
    expect(await captureProof({ runtime: lying, verifier: xv, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' })).toMatchObject({ ok: false, kind: 'DENIED' });
    expect(store.list()).toEqual([]);
  });

  it('26. cloned, spread, JSON-roundtripped and prototype-substituted provenance is rejected; only the issued object is accepted', async () => {
    const rig = await issue();
    expect(isIssuedObservation(rig.observation)).toBe(true);
    for (const forged of [structuredClone(rig.observation), { ...rig.observation }, JSON.parse(JSON.stringify(rig.observation)), Object.create(rig.observation), Object.assign(Object.create(null), rig.observation), { claims: { ...rig.observation.claims }, body: rig.observation.body, signature: rig.observation.signature }]) {
      expect(isIssuedObservation(forged)).toBe(false);
      expect(await rig.verifier.verify(forged, exp())).toEqual({ ok: false, reason: 'NOT_ISSUED_BY_RUNTIME' });
    }
    expect(Object.isFrozen(rig.observation) && Object.isFrozen(rig.observation.claims)).toBe(true);
    for (const junk of [null, undefined, 'x', 5, [], {}]) expect(await rig.verifier.verify(junk, exp())).toMatchObject({ ok: false });
    // the body the runtime signed is a private copy: mutating the provider's own object afterwards changes nothing
    const inv: any = invoice(); const t = new ScriptedReadTransport([account, inv]); const r2 = await issue({ transport: t });
    inv.total = 1; inv.lines.data.length = 0;
    expect((r2.observation.body as any).total).toBe(2700);
    expect(await r2.verifier.verify(r2.observation, exp())).toMatchObject({ ok: true });
  });
});

describe('the runtime gate itself', () => {
  it('an unsupported API version, a write-shaped or unauthorized method, a missing invoice id and a bad request make zero requests and issue nothing', async () => {
    const t = new ScriptedReadTransport([account, invoice()]); const rig = runtimeOver(t, gateFor(AUTH), () => NOW);
    expect(await rig.runtime.read({ ...REQ, apiVersion: '2025-01-01.acacia' })).toEqual({ ok: false, kind: 'DENIED', reason: 'UNSUPPORTED_API_VERSION' });
    for (const bad of ['REFUNDS_CREATE', 'POST /v1/refunds', 'INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST', '__proto__', '', undefined, 5]) expect(await rig.runtime.read({ ...REQ, methodId: bad as any }), String(bad)).toEqual({ ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' });
    expect(await rig.runtime.read({ ...REQ, invoiceId: 'cus_1' })).toEqual({ ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' });
    expect(await rig.runtime.read({ ...REQ, accountId: 'cus_1' })).toEqual({ ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' });
    expect(t.calls).toEqual([]);
  });
});

describe('27-30. proofs are bound to their content, business, account, invoice and method', () => {
  it('27. altered proof fields are rejected: every claim, the signature and the body', async () => {
    const rig = await issue(); const xv = cross(rig); const c = rig.observation.claims;
    expect(await xv.verify(structuredClone(rig.observation), exp())).toMatchObject({ ok: true }); // an exact copy verifies in the cross-process view: the signature is what matters there
    const alter: Record<string, unknown> = {
      businessId: 'biz-2', accountId: 'acct_Other1', workloadId: 'wl-other', methodId: 'ACCOUNT_RETRIEVE_CURRENT', apiVersion: '2025-01-01.acacia', subject: 'in_2', requestId: '00000000-0000-4000-8000-000000000000',
      observedAtMs: c.observedAtMs - 1, authorizationId: 'auth-forged', authorizationVersion: c.authorizationVersion + 1, fingerprint: 'f'.repeat(64), keyId: 'other-key', contractVersion: 'S08-STRIPE-OBSERVATION/2', realm: 'live',
    };
    for (const [k, v] of Object.entries(alter)) {
      const r = await xv.verify({ ...structuredClone(rig.observation), claims: { ...structuredClone(c), [k]: v } }, exp());
      expect(r.ok, `claim ${k}`).toBe(false);
    }
    expect(await xv.verify({ ...structuredClone(rig.observation), claims: { ...structuredClone(c), extra: 1 } }, exp())).toEqual({ ok: false, reason: 'MALFORMED_OBSERVATION' });
    expect(await xv.verify({ ...structuredClone(rig.observation), claims: { ...structuredClone(c), realm: 'live' } }, exp())).toEqual({ ok: false, reason: 'MALFORMED_OBSERVATION' }); // a live realm is not even a parseable claim
    expect(await cross(rig, () => c.observedAtMs - 1).verify(structuredClone(rig.observation), exp())).toEqual({ ok: false, reason: 'OBSERVED_IN_FUTURE' }); // an observation from the future
    expect(await xv.verify({ ...structuredClone(rig.observation), body: { ...(rig.observation.body as object), total: 1 } }, exp())).toEqual({ ok: false, reason: 'FINGERPRINT_MISMATCH' });
    const flipped = (rig.observation.signature[0] === 'a' ? 'b' : 'a') + rig.observation.signature.slice(1);
    expect(await xv.verify({ ...structuredClone(rig.observation), signature: flipped }, exp())).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(await xv.verify({ ...structuredClone(rig.observation), signature: 'zz' }, exp())).toEqual({ ok: false, reason: 'MALFORMED_OBSERVATION' });
    // signature domain separation: the signed bytes begin with the observation label and contain the contract-bound fields only
    expect(new TextDecoder().decode(observationMessage(c))).toContain('ECHO-GRID:S08-STRIPE-OBSERVATION-SIG/1');
    expect(c.contractVersion).toBe(OBSERVATION_CONTRACT_VERSION);
  });

  it('28-30. a proof for another account, invoice, method, business, workload or API version is rejected', async () => {
    const rig = await issue();
    expect(await rig.verifier.verify(rig.observation, exp({ accountId: 'acct_Other1' }))).toEqual({ ok: false, reason: 'BINDING_ACCOUNT' }); // 28
    expect(await rig.verifier.verify(rig.observation, exp({ subject: 'in_other' }))).toEqual({ ok: false, reason: 'BINDING_SUBJECT' }); // 29
    expect(await rig.verifier.verify(rig.observation, exp({ methodId: 'ACCOUNT_RETRIEVE_CURRENT' }))).toEqual({ ok: false, reason: 'BINDING_METHOD' }); // 30
    expect(await rig.verifier.verify(rig.observation, exp({ businessId: 'biz-2' }))).toEqual({ ok: false, reason: 'BINDING_BUSINESS' });
    expect(await rig.verifier.verify(rig.observation, exp({ workloadId: 'wl-other' }))).toEqual({ ok: false, reason: 'BINDING_WORKLOAD' });
    expect(await rig.verifier.verify(rig.observation, exp({ apiVersion: '2025-01-01.acacia' }))).toEqual({ ok: false, reason: 'BINDING_API_VERSION' });
    expect(await rig.verifier.verify(rig.observation, exp({ kind: 'bogus' as any }))).toEqual({ ok: false, reason: 'KIND_MISMATCH' });
    // the provider path enforces the same binding: a runtime that returns an observation for another invoice yields a denial and no body
    const { createRealReadProvider } = await import('./read-provider');
    const wrong: TrustedReadRuntime = { ...rig.runtime, read: async () => ({ ok: true, observation: rig.observation }) };
    const provider = createRealReadProvider({ runtime: wrong, verifier: rig.verifier, clock: () => NOW, audit: () => undefined });
    expect(await provider.getInvoice({ businessId: 'biz-1', invoiceId: 'in_other', accountId: ACCT })).toEqual({ ok: false, kind: 'DENIED', reason: 'BINDING_SUBJECT' });
    expect(provider.provenance()).toEqual([]);
  });
});

describe('31-32. signing authority: expired, revoked, untrusted or unavailable authority issues and verifies nothing', () => {
  it('31. an expired or not-yet-valid signing key cannot issue new observations (zero requests) and cannot verify old ones', async () => {
    const rig = await issue(); const t = new ScriptedReadTransport([account, invoice()]);
    const r2 = runtimeOver(t, gateFor(AUTH), () => NOW, rig.trust);
    rig.trust.entry.notAfterMs = NOW;
    expect(await r2.runtime.read(REQ)).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_EXPIRED' }); expect(t.calls).toEqual([]);
    expect(await rig.verifier.verify(rig.observation, exp())).toEqual({ ok: false, reason: 'SIGNING_KEY_EXPIRED' });
    rig.trust.entry.notAfterMs = NOW * 100; rig.trust.entry.notBeforeMs = NOW + 1;
    expect(await r2.runtime.read(REQ)).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_NOT_YET_VALID' }); expect(t.calls).toEqual([]);
    rig.trust.entry.notBeforeMs = 0; expect((await r2.runtime.read(REQ)).ok).toBe(true);
    // an observation made outside the key's validity window is refused even if the key is valid now
    rig.trust.entry.notBeforeMs = NOW + 5;
    const later = createObservationVerifier({ keyRing: rig.trust.keyRing, clock: () => NOW + 10 });
    expect(await later.verify(rig.observation, exp())).toEqual({ ok: false, reason: 'OBSERVED_OUTSIDE_KEY_WINDOW' });
  });

  it('32. a revoked key cannot issue (zero requests) and old observations stop verifying; an unknown key, an unavailable key ring and a malformed entry fail closed', async () => {
    const rig = await issue(); const t = new ScriptedReadTransport([account, invoice()]);
    const r2 = runtimeOver(t, gateFor(AUTH), () => NOW, rig.trust);
    rig.trust.entry.revokedAtMs = NOW - 1;
    expect(await r2.runtime.read(REQ)).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_REVOKED' }); expect(t.calls).toEqual([]);
    expect(await rig.verifier.verify(rig.observation, exp())).toEqual({ ok: false, reason: 'SIGNING_KEY_REVOKED' });
    rig.trust.entry.revokedAtMs = null;
    const other = syntheticTrust('SYNTHETIC_RUNTIME', 'some-other-key');
    const unknown = createObservationVerifier({ keyRing: other.keyRing, clock: () => NOW });
    expect(await unknown.verify(rig.observation, exp())).toEqual({ ok: false, reason: 'SIGNING_KEY_NOT_TRUSTED' });
    const down = createObservationVerifier({ keyRing: () => { throw new Error('config store down'); }, clock: () => NOW });
    expect(await down.verify(rig.observation, exp())).toEqual({ ok: false, reason: 'SIGNING_AUTHORITY_UNAVAILABLE' });
    const t3 = new ScriptedReadTransport([account, invoice()]);
    const noRing = createSyntheticTrustedRuntime({ signer: rig.trust.signer, keyRing: async () => { throw new Error('down'); }, gate: gateFor(AUTH), clock: () => NOW, transport: t3 });
    expect(await noRing.read(REQ)).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_AUTHORITY_UNAVAILABLE' }); expect(t3.calls).toEqual([]);
    for (const bad of [{ ...rig.trust.entry, publicKeyHex: 'xyz' }, { ...rig.trust.entry, purpose: 'ANYTHING' }, { ...rig.trust.entry, notAfterMs: 0 }, { ...rig.trust.entry, revokedAtMs: 'never' }, null, 'x']) {
      const v = createObservationVerifier({ keyRing: () => ({ [rig.trust.keyId]: bad as any }), clock: () => NOW });
      expect(await v.verify(rig.observation, exp()), JSON.stringify(bad)).toEqual({ ok: false, reason: 'SIGNING_KEY_NOT_TRUSTED' });
    }
    expect(await createObservationVerifier({ keyRing: () => ({}) as any, clock: () => NOW }).verify(rig.observation, exp())).toEqual({ ok: false, reason: 'SIGNING_KEY_NOT_TRUSTED' });
    expect(() => createSyntheticTrustedRuntime({ signer: null as any, keyRing: rig.trust.keyRing, gate: gateFor(AUTH), clock: () => NOW, transport: t3 })).toThrow(/CREDENTIAL_SOURCE_INVALID/);
    expect(() => createTrustedStripeRuntime({ signer: rig.trust.signer, keyRing: rig.trust.keyRing, gate: gateFor(AUTH), credentials: undefined as any, clock: () => NOW })).toThrow(/CREDENTIAL_SOURCE_INVALID/);
  });
});

describe('33-34. idempotent capture and the synthetic runtime fixture', () => {
  it('33. duplicate proof capture is idempotent: independent observations of the same response (distinct request ids) yield one proof record', async () => {
    const store = createInMemoryProofStore(); const gate = gateFor(AUTH, { mapping: MappingRegistry.catalog() });
    const mk = () => captureOver({ transport: new ScriptedReadTransport([account, invoice()]), gate, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1' });
    const [a, b, c] = [await mk(), await mk(), await mk()];
    if (!a.ok || !b.ok || !c.ok) throw new Error('capture');
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([false, true, true]);
    expect(store.list()).toHaveLength(1); expect(b.proof.observationRequestId).toBe(a.proof.observationRequestId); // the stored record is the first, unchanged
    // concurrent captures resolve to one record too
    const store2 = createInMemoryProofStore();
    const rs = await Promise.all(Array.from({ length: 6 }, () => captureOver({ transport: new ScriptedReadTransport([account, invoice()]), gate, store: store2, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' })));
    expect(rs.filter(r => r.ok && !r.duplicate)).toHaveLength(1); expect(store2.list()).toHaveLength(1);
  });

  it('34. a trusted synthetic runtime produces internally verifiable test provenance without impersonating a real Stripe response', async () => {
    const rig = await issue(); const c = rig.observation.claims;
    expect(c).toMatchObject({ kind: 'SYNTHETIC_RUNTIME', businessId: 'biz-1', accountId: ACCT, workloadId: WORKLOAD, realm: 'test', methodId: 'INVOICE_RETRIEVE', apiVersion: API, subject: 'in_1', authorizationId: 'auth-INVOICE_RETRIEVE', authorizationVersion: 2, contractVersion: OBSERVATION_CONTRACT_VERSION });
    expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/); expect(c.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(c.observedAtMs).toBe(NOW);
    expect(await rig.verifier.verify(rig.observation, exp())).toMatchObject({ ok: true, kind: 'SYNTHETIC_RUNTIME', body: rig.observation.body });
    // the provider records the verified claims of what it served, and nothing else
    const { createRealReadProvider } = await import('./read-provider');
    const prov = createRealReadProvider({ runtime: rig.runtime, verifier: rig.verifier, clock: () => NOW, audit: () => undefined });
    expect(prov.provenance()).toEqual([]); expect(prov.authenticity).toBe('SYNTHETIC_RUNTIME');
    expect((await prov.getInvoice({ businessId: 'biz-1', invoiceId: 'in_1', accountId: ACCT })).ok).toBe(true);
    expect(prov.provenance().map(x => [x.methodId, x.subject, x.kind, x.authorizationId])).toEqual([['INVOICE_RETRIEVE', 'in_1', 'SYNTHETIC_RUNTIME', 'auth-INVOICE_RETRIEVE']]);
    expect(JSON.stringify(prov.provenance())).not.toMatch(/amount|total|lines|customer/); // claims only: no body
    expect(await rig.verifier.verify(rig.observation, exp({ kind: 'REAL_NETWORK' }))).toMatchObject({ ok: false }); // never accepted as real
    expect(sealedOriginOf(rig.observation)).toBeNull();
    // two reads are two distinct signed requests of the same content
    const second = await rig.runtime.read(REQ);
    if (!second.ok) throw new Error('second'); expect(second.observation.claims.requestId).not.toBe(c.requestId); expect(second.observation.claims.fingerprint).toBe(c.fingerprint);
  });
});

describe('the real runtime (platform fetch stubbed): the same chain, authentic only with a trusted-runtime key', () => {
  it('a TRUSTED_RUNTIME key over the stubbed platform fetch yields a REAL_NETWORK observation, bound credential per request, GET only, fixed paths', async () => {
    const calls = stubFetch(); const trust = syntheticTrust('TRUSTED_RUNTIME');
    const resolved: string[] = []; const credentials: CredentialSource = { async resolve(b) { resolved.push(`${b.accountId}|${b.workloadId}`); return { apiKey: GOOD_KEY, accountId: ACCT, workloadId: WORKLOAD, validUntilMs: NOW + 1000 }; } };
    const runtime = createTrustedStripeRuntime({ signer: trust.signer, keyRing: trust.keyRing, gate: gateFor(AUTH), credentials, clock: () => NOW });
    const verifier = createObservationVerifier({ keyRing: trust.keyRing, clock: () => NOW });
    const out = await runtime.read(REQ);
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(await verifier.verify(out.observation, exp({ kind: 'REAL_NETWORK' }))).toMatchObject({ ok: true, kind: 'REAL_NETWORK' });
    expect(calls).toEqual(['https://api.stripe.com/v1/invoices/in_1']); expect(resolved).toEqual([`${ACCT}|${WORKLOAD}`]);
    // authorization is rechecked before each request: revoke between two reads
    const g = gateFor(AUTH, { mapping: MappingRegistry.catalog() }); const rt = createTrustedStripeRuntime({ signer: trust.signer, keyRing: trust.keyRing, gate: g, credentials, clock: () => NOW });
    expect(await rt.read({ ...REQ, methodId: 'ACCOUNT_RETRIEVE_CURRENT' })).toEqual({ ok: false, kind: 'DENIED', reason: 'MAPPING_NOT_VERIFIED' }); // no verified mapping exists, so no real EVIDENCE read at all
    const gp = gateFor(AUTH, { mapping: MappingRegistry.catalog() });
    const rp = createTrustedStripeRuntime({ signer: trust.signer, keyRing: trust.keyRing, gate: gp, credentials, clock: () => NOW });
    expect((await rp.read({ ...REQ, methodId: 'ACCOUNT_RETRIEVE_CURRENT', purpose: 'PROOF' })).ok).toBe(true);
    (gp as any).admin.apply('auth-INVOICE_RETRIEVE', { type: 'REVOKE' }, NOW - 1);
    expect(await rp.read({ ...REQ, purpose: 'PROOF' })).toEqual({ ok: false, kind: 'DENIED', reason: 'AUTHORIZATION_REVOKED' });
  });

  it('no module outside tests and fixtures can supply a transport to the real runtime, and the synthetic runtime is not part of the package index', () => {
    const dir = resolve(__dirname);
    const idx = readFileSync(resolve(dir, 'index.ts'), 'utf8');
    expect(idx).not.toMatch(/synthetic-runtime|makeRuntime/);
    const users = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'pipeline-fixtures.ts' && f !== 'synthetic-runtime.ts').filter(f => /from '\.\/synthetic-runtime'/.test(readFileSync(resolve(dir, f), 'utf8')));
    expect(users).toEqual([]);
    const tr = readFileSync(resolve(dir, 'trusted-runtime.ts'), 'utf8');
    const sig = tr.slice(tr.indexOf('export function createTrustedStripeRuntime'), tr.indexOf('export function createTrustedStripeRuntime') + 600);
    expect(sig).not.toMatch(/transport\??:|fetchImpl|fetch\??:/);
    expect(readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).every(f => !/\.networkSource|networkSource\??\s*:|networkSource\s*[=,]/.test(readFileSync(resolve(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))).toBe(true);
    void createStripeGetTransport; void ({} as ReadAuditEvent);
  });
});
