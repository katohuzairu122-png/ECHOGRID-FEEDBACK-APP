/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyProof, authorizeRead, captureProof, checkRead, createInMemoryAuthorizationStore, createInMemoryProofStore, createRealReadProvider, createStripeGetTransport, DEFAULT_MAPPING_CATALOG, evaluateCompatibility,
  EvidenceAcquisitionPipeline, isSealedProof, MappingRegistry, observeShape, parseAuthorizationRecord, ScriptedReadTransport, syntheticProofResponses, transitionAuthorization, unavailableAuthorizationStore,
  CredentialDenied, PROOF_ACCOUNT_ID,
  type CredentialSource, type ReadAuditEvent, type ReadAuthorizationStore, type StripeReadTransport,
} from './index';
import { buildProof } from './proof-capture';
import {
  ACCT, API, account, AUTH, binding, CONFIG, gateFor, invocationHarness, invoice, mockProvider, NOW, recordFor, SYNTHETIC_ACCOUNT_KEY, verifiedMapping, WORKLOAD,
} from './pipeline-fixtures';

/**
 * S08-D1D3-DEV-09 acceptance tests. Fake transports, injected fetch functions and synthetic fixtures only: no network, no real key, no Stripe account. One test stubs the platform fetch to exercise the
 * code path a real capture takes; the stub proves nothing about Stripe. Mapping verification against real responses has NOT been performed (Q1/Q2).
 */
afterEach(() => { vi.unstubAllGlobals(); });

const REQ = { businessId: 'biz-1', invoiceId: 'in_1' };
const GOOD_KEY = SYNTHETIC_ACCOUNT_KEY;
const credSource = (over: Partial<{ apiKey: string; accountId: string; workloadId: string; validUntilMs: number }> | null = {}): CredentialSource & { resolved: number } => {
  const s = { resolved: 0, async resolve() { s.resolved++; return over === null ? null : { apiKey: GOOD_KEY, accountId: ACCT, workloadId: WORKLOAD, validUntilMs: NOW + 3_600_000, ...over }; } };
  return s;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
function routedFetch(routes: (url: string, init: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (u: any, init: any) => { calls.push({ url: String(u), init }); return routes(String(u), init); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const stripeRoutes = (inv: unknown = invoice()) => (url: string) => (url.endsWith('/v1/account') ? json(account) : url.includes('/v1/invoices/') ? json(inv) : json({}, 404));
const transportOver = (r = routedFetch(stripeRoutes()), c: CredentialSource & { resolved?: number } = credSource()) => ({ ...r, source: c, transport: createStripeGetTransport({ credentials: c, fetchImpl: r.fetchImpl, clock: () => NOW }) });

function rig(over: { gate?: ReturnType<typeof gateFor>; responses?: unknown[]; transport?: StripeReadTransport } = {}) {
  const transport = over.transport ?? new ScriptedReadTransport(over.responses ?? [account, invoice()]);
  const gate = over.gate ?? gateFor(AUTH);
  const events: ReadAuditEvent[] = []; const h = invocationHarness();
  const provider = createRealReadProvider({ transport, gate, clock: () => NOW, audit: e => events.push(e) });
  const pipeline = new EvidenceAcquisitionPipeline<string>({ provider, config: CONFIG, clock: () => NOW, audit: e => events.push(e), resolveBinding: async () => binding(), invocation: { policy: h.policy, deps: h.deps } });
  return { transport, gate, events, pipeline, h, run: () => pipeline.run(REQ, h.pair()) };
}
const calls = (t: StripeReadTransport) => (t as ScriptedReadTransport).calls;
const q = (over: Record<string, unknown> = {}) => ({ businessId: 'biz-1', accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', realm: 'test', ...over }) as any;

describe('A. authorization records and enforcement (zero requests on any denial)', () => {
  it('1-3. missing, revoked and expired authorization cause zero provider requests', async () => {
    const missing = rig({ gate: gateFor(null) }); expect(await missing.run()).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_MISSING' }); expect(calls(missing.transport)).toEqual([]);
    const revoked = rig({ gate: gateFor({ ...AUTH, revoked: true }) }); expect(await revoked.run()).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_REVOKED' }); expect(calls(revoked.transport)).toEqual([]);
    const expired = rig({ gate: gateFor({ ...AUTH, expiresAtMs: NOW }) }); expect(await expired.run()).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_EXPIRED' }); expect(calls(expired.transport)).toEqual([]);
    const pending = rig({ gate: gateFor({ ...AUTH, approved: false }) }); expect(await pending.run()).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_NOT_APPROVED' }); expect(calls(pending.transport)).toEqual([]);
    // boundary: valid from its start instant, expired exactly at its expiry
    const { store, admin } = createInMemoryAuthorizationStore();
    admin.add(recordFor('INVOICE_RETRIEVE', { validFromMs: 1000, expiresAtMs: 2000 })); admin.apply('auth-INVOICE_RETRIEVE', { type: 'APPROVE', approvedBy: 'owner-1' }, 500);
    expect((await authorizeRead(store, q(), 999)).allowed).toBe(false); expect((await authorizeRead(store, q(), 999) as any).reason).toBe('AUTHORIZATION_NOT_YET_VALID');
    expect((await authorizeRead(store, q(), 1000)).allowed).toBe(true); expect((await authorizeRead(store, q(), 1999)).allowed).toBe(true);
    expect(await authorizeRead(store, q(), 2000)).toEqual({ allowed: false, reason: 'AUTHORIZATION_EXPIRED' });
  });

  it('4. an unauthorized method causes zero requests and zero store reads; no record, however approved, can enable a method without a transport path', async () => {
    const lookups: unknown[] = []; const spy: ReadAuthorizationStore = { async lookup(x) { lookups.push(x); return []; } };
    for (const id of ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST']) expect(await authorizeRead(spy, q({ methodId: id }), NOW)).toEqual({ allowed: false, reason: 'METHOD_NOT_AUTHORIZED' });
    expect(lookups).toEqual([]);
    const { store, admin } = createInMemoryAuthorizationStore();
    for (const id of ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST']) { expect(admin.add(recordFor(id)).ok).toBe(true); admin.apply(`auth-${id}`, { type: 'APPROVE', approvedBy: 'owner-1' }, 2); }
    for (const id of ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST']) expect(await authorizeRead(store, q({ methodId: id }), NOW)).toEqual({ allowed: false, reason: 'METHOD_NOT_AUTHORIZED' });
    const only = rig({ gate: gateFor({ ...AUTH, methods: ['ACCOUNT_RETRIEVE_CURRENT'] }) }); // the invoice read has no record
    expect(await only.run()).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_MISSING' }); expect(calls(only.transport)).toEqual([]);
  });

  it('5-8. a wrong business, account, workload or realm is denied', async () => {
    const { store, admin } = createInMemoryAuthorizationStore();
    admin.add(recordFor('INVOICE_RETRIEVE')); admin.apply('auth-INVOICE_RETRIEVE', { type: 'APPROVE', approvedBy: 'owner-1' }, 2);
    expect((await authorizeRead(store, q(), NOW)).allowed).toBe(true);
    expect(await authorizeRead(store, q({ businessId: 'biz-2' }), NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_MISSING' }); // another tenant has no record
    expect(await authorizeRead(store, q({ accountId: 'acct_Other' }), NOW)).toEqual({ allowed: false, reason: 'ACCOUNT_MISMATCH' });
    expect(await authorizeRead(store, q({ workloadId: 'wl-other' }), NOW)).toEqual({ allowed: false, reason: 'WORKLOAD_MISMATCH' });
    for (const realm of ['live', undefined, null, 'TEST', '']) expect(await authorizeRead(store, q({ realm }), NOW)).toEqual({ allowed: false, reason: 'REALM_NOT_TEST' });
    // a misbehaving store that hands back another tenant's record is not believed
    const leaky: ReadAuthorizationStore = { async lookup() { return [{ ...recordFor('INVOICE_RETRIEVE', { businessId: 'biz-2', state: 'APPROVED', approvedBy: 'o' }) }]; } };
    expect(await authorizeRead(leaky, q(), NOW)).toEqual({ allowed: false, reason: 'BUSINESS_MISMATCH' });
    // through the pipeline, with zero requests
    for (const [gate, reason] of [[gateFor(AUTH, { businessId: 'biz-2' }), 'AUTHORIZATION_MISSING'], [gateFor({ ...AUTH, accountId: 'acct_Other' }), 'ACCOUNT_MISMATCH'], [gateFor(AUTH, { workloadId: 'wl-x' }), 'WORKLOAD_MISMATCH']] as const) {
      const r = rig({ gate: Object.assign(gate, { workloadId: reason === 'WORKLOAD_MISMATCH' ? 'wl-other-runtime' : gate.workloadId }) });
      expect(await r.run(), reason).toEqual({ status: 'DENIED', reason }); expect(calls(r.transport), reason).toEqual([]);
    }
    expect(parseAuthorizationRecord({ ...recordFor('INVOICE_RETRIEVE'), realm: 'live' })).toBeNull();
  });

  it('9. malformed authorization records are rejected (parse) and make the whole answer untrusted (lookup)', async () => {
    const good = recordFor('INVOICE_RETRIEVE', { state: 'APPROVED', approvedBy: 'owner-1' });
    expect(parseAuthorizationRecord(good)).not.toBeNull();
    const bad: any[] = [null, undefined, 'x', 5, [], {}, { ...good, extra: 1 }, { ...good, authorizationId: '' }, { ...good, authorizationId: ' x' }, { ...good, businessId: 5 }, { ...good, accountId: 'cus_1' }, { ...good, realm: 'live' },
      { ...good, methodId: 'POST /v1/refunds' }, { ...good, methodId: '__proto__' }, { ...good, state: 'DELETED' }, { ...good, state: 'APPROVED', approvedBy: null }, { ...good, state: 'PENDING', approvedBy: 'x' },
      { ...good, validFromMs: -1 }, { ...good, validFromMs: 1.5 }, { ...good, expiresAtMs: good.validFromMs }, { ...good, expiresAtMs: NaN }, { ...good, revokedAtMs: 5 }, { ...good, state: 'REVOKED', revokedAtMs: null },
      { ...good, inventoryRecordId: 'other' }, { ...good, inventoryRevision: '' }, (() => { const c: any = { ...good }; delete c.workloadId; return c; })()];
    for (const b of bad) {
      expect(parseAuthorizationRecord(b), JSON.stringify(b)).toBeNull();
      const st: ReadAuthorizationStore = { async lookup() { return [good, b]; } };
      expect(await authorizeRead(st, q(), NOW), JSON.stringify(b)).toEqual({ allowed: false, reason: 'AUTHORIZATION_MALFORMED' });
    }
    for (const nonArray of [null, undefined, {}, 'x']) expect(await authorizeRead({ async lookup() { return nonArray as any; } }, q(), NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_MALFORMED' });
  });

  it('10. callers cannot forge approval: no request property, store write, returned copy or state transition grants it', async () => {
    const r = rig({ gate: gateFor(null) });
    for (const extra of [{ authorization: { approved: true } }, { approved: true }, { gate: {} }, { authorizationId: 'x' }, { workloadId: WORKLOAD }, { methods: ['INVOICE_RETRIEVE'] }, { mapping: 'TEST_MODE_VERIFIED' }])
      expect(await r.pipeline.run({ ...REQ, ...extra } as any, r.h.pair())).toEqual({ status: 'DENIED', reason: 'CALLER_ASSERTION_REFUSED' });
    expect(calls(r.transport)).toEqual([]);
    const { store, admin } = createInMemoryAuthorizationStore();
    expect(Object.keys(store)).toEqual(['lookup']); // the enforcement view has no write method
    expect(admin.add(recordFor('INVOICE_RETRIEVE', { state: 'APPROVED', approvedBy: 'forger' }))).toEqual({ ok: false, reason: 'NOT_PENDING' }); // a record cannot be created already approved
    admin.add(recordFor('INVOICE_RETRIEVE'));
    expect(admin.add(recordFor('INVOICE_RETRIEVE'))).toEqual({ ok: false, reason: 'DUPLICATE' });
    const copies = (await store.lookup({ businessId: 'biz-1', methodId: 'INVOICE_RETRIEVE' })) as any[];
    copies[0].state = 'APPROVED'; copies[0].approvedBy = 'forger'; // mutating what lookup returned changes nothing
    expect(await authorizeRead(store, q(), NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_NOT_APPROVED' });
    expect(transitionAuthorization(recordFor('INVOICE_RETRIEVE'), { type: 'APPROVE', approvedBy: '' }, 2)).toEqual({ ok: false, reason: 'APPROVER_REQUIRED' });
    expect(transitionAuthorization(recordFor('INVOICE_RETRIEVE'), { type: 'APPROVE', approvedBy: 'a b' }, 2)).toEqual({ ok: false, reason: 'APPROVER_REQUIRED' });
    expect(transitionAuthorization(recordFor('INVOICE_RETRIEVE', { expiresAtMs: 100 }), { type: 'APPROVE', approvedBy: 'o' }, 100)).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(transitionAuthorization({ junk: true }, { type: 'APPROVE', approvedBy: 'o' }, 2)).toEqual({ ok: false, reason: 'RECORD_INVALID' });
    expect(transitionAuthorization(recordFor('INVOICE_RETRIEVE'), { type: 'DELETE' } as any, 2)).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
  });

  it('state machine: PENDING -> APPROVED -> REVOKED, PENDING -> REVOKED, REVOKED is terminal (a new grant needs a new record), expiry is derived', async () => {
    const pending = recordFor('INVOICE_RETRIEVE');
    const approved = transitionAuthorization(pending, { type: 'APPROVE', approvedBy: 'owner-1' }, 5); if (!approved.ok) throw new Error('approve');
    expect(approved.record).toMatchObject({ state: 'APPROVED', approvedBy: 'owner-1', revokedAtMs: null });
    expect(transitionAuthorization(approved.record, { type: 'APPROVE', approvedBy: 'owner-2' }, 6)).toEqual({ ok: false, reason: 'INVALID_TRANSITION' }); // no double approval or re-approval
    const revoked = transitionAuthorization(approved.record, { type: 'REVOKE' }, 7); if (!revoked.ok) throw new Error('revoke');
    expect(revoked.record).toMatchObject({ state: 'REVOKED', revokedAtMs: 7 });
    expect(transitionAuthorization(revoked.record, { type: 'REVOKE' }, 8)).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
    expect(transitionAuthorization(revoked.record, { type: 'APPROVE', approvedBy: 'o' }, 8)).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
    expect(transitionAuthorization(pending, { type: 'REVOKE' }, 4)).toMatchObject({ ok: true, record: { state: 'REVOKED' } });
    expect(Object.isFrozen(approved.record)).toBe(true);
    // a newer grant after a revocation is honoured; the revoked one never is
    const { store, admin } = createInMemoryAuthorizationStore();
    admin.add(recordFor('INVOICE_RETRIEVE')); admin.apply('auth-INVOICE_RETRIEVE', { type: 'APPROVE', approvedBy: 'o' }, 2); admin.apply('auth-INVOICE_RETRIEVE', { type: 'REVOKE' }, 3);
    expect(await authorizeRead(store, q(), NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_REVOKED' });
    admin.add(recordFor('INVOICE_RETRIEVE', { authorizationId: 'auth-2' })); admin.apply('auth-2', { type: 'APPROVE', approvedBy: 'o' }, 4);
    expect(await authorizeRead(store, q(), NOW)).toMatchObject({ allowed: true, record: { authorizationId: 'auth-2' } });
  });

  it('11. an authorization-store failure blocks retrieval, at the start and between requests', async () => {
    expect(await authorizeRead(unavailableAuthorizationStore, q(), NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_STORE_UNAVAILABLE' });
    const down = rig({ gate: Object.assign(gateFor(AUTH), { store: unavailableAuthorizationStore }) });
    expect(await down.run()).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_STORE_UNAVAILABLE' }); expect(calls(down.transport)).toEqual([]);
    // the store goes down after the preflight: the very next request is refused
    const g = gateFor(AUTH); let n = 0;
    const flaky: ReadAuthorizationStore = { async lookup(x) { if (++n > 2) throw new Error('db down'); return g.store.lookup(x); } };
    const mid = rig({ gate: Object.assign(g, { store: flaky }) });
    const out = await mid.run();
    expect(out).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_STORE_UNAVAILABLE' });
    expect(calls(mid.transport).length).toBeLessThan(3);
  });

  it('28. revocation is enforced between requests: a request that follows the revocation is refused', async () => {
    const gate = gateFor(AUTH);
    class RevokingTransport extends ScriptedReadTransport {
      override async get(method: any, params?: any) { const r = await super.get(method, params); if (method === 'ACCOUNT_RETRIEVE_CURRENT') gate.admin.apply('auth-INVOICE_RETRIEVE', { type: 'REVOKE' }, NOW - 1); return r; }
    }
    const r = rig({ gate, transport: new RevokingTransport([account, invoice()]) });
    expect(await r.run()).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_REVOKED' });
    expect(calls(r.transport).map(c => c.method)).toEqual(['ACCOUNT_RETRIEVE_CURRENT']); // the invoice request never left
    // and the proof path
    const g2 = gateFor(AUTH, { mapping: MappingRegistry.catalog() });
    class RevokingTransport2 extends ScriptedReadTransport { override async get(m: any, p?: any) { const x = await super.get(m, p); if (m === 'ACCOUNT_RETRIEVE_CURRENT') g2.admin.apply('auth-INVOICE_RETRIEVE', { type: 'REVOKE' }, NOW - 1); return x; } }
    const out = await captureProof({ transport: new RevokingTransport2([account, invoice()]), gate: g2, store: createInMemoryProofStore(), clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1' });
    expect(out).toEqual({ ok: false, kind: 'DENIED', reason: 'AUTHORIZATION_REVOKED' });
  });

  it('33. concurrent authorization attempts never expand the permitted capabilities', async () => {
    const { store, admin } = createInMemoryAuthorizationStore();
    for (const id of ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE']) { admin.add(recordFor(id)); admin.apply(`auth-${id}`, { type: 'APPROVE', approvedBy: 'o' }, 2); }
    const attempts: Array<[any, boolean]> = [];
    for (let i = 0; i < 60; i++) {
      attempts.push([q({ methodId: 'INVOICE_RETRIEVE' }), true], [q({ methodId: 'ACCOUNT_RETRIEVE_CURRENT' }), true], [q({ methodId: 'REFUNDS_LIST' }), false], [q({ methodId: 'DISPUTES_LIST' }), false],
        [q({ methodId: 'PAYMENT_RETRIEVE' }), false], [q({ methodId: 'INVOICE_LINES_LIST' }), false], [q({ workloadId: 'wl-x' }), false], [q({ accountId: 'acct_X' }), false], [q({ businessId: 'biz-2' }), false], [q({ methodId: 'POST /v1/refunds' }), false], [q({ realm: 'live' }), false]);
    }
    const results = await Promise.all(attempts.map(([x]) => authorizeRead(store, x, NOW)));
    results.forEach((res, i) => expect(res.allowed, JSON.stringify(attempts[i]![0])).toBe(attempts[i]![1]));
    // mixed with a concurrent revocation: afterwards nothing is allowed and nothing was ever allowed beyond the two methods
    const during = Promise.all(Array.from({ length: 100 }, (_, i) => authorizeRead(store, q({ methodId: i % 2 ? 'INVOICE_RETRIEVE' : 'REFUNDS_LIST' }), NOW)));
    admin.apply('auth-INVOICE_RETRIEVE', { type: 'REVOKE' }, NOW);
    const seen = await during;
    seen.forEach((res, i) => { if (i % 2 === 0) expect(res.allowed).toBe(false); });
    expect((await authorizeRead(store, q(), NOW)).allowed).toBe(false);
  });
});

describe('B. credentials and the restricted transport', () => {
  it('12. synthetic test credentials are accepted only through a bound, unexpired source, and are sent only as the Authorization header of a fixed GET', async () => {
    const t = transportOver();
    const b = { accountId: ACCT, workloadId: WORKLOAD };
    expect(await t.transport.get('ACCOUNT_RETRIEVE_CURRENT', undefined, b)).toEqual(account);
    expect(await t.transport.get('INVOICE_RETRIEVE', { invoiceId: 'in_1' }, b)).toMatchObject({ id: 'in_1' });
    expect(t.calls.map(c => [c.init.method, c.url])).toEqual([['GET', 'https://api.stripe.com/v1/account'], ['GET', 'https://api.stripe.com/v1/invoices/in_1']]);
    expect(t.calls[0]!.init.headers.Authorization).toBe(`Bearer ${GOOD_KEY}`);
    expect(t.transport.networkSource).toBe('INJECTED'); expect((t.source as { resolved: number }).resolved).toBe(2); // resolved per request, never cached in the transport
    expect(() => createStripeGetTransport({ apiKey: GOOD_KEY, credentials: credSource() })).toThrow(/CREDENTIAL_SOURCE_INVALID/); // exactly one source
    expect(() => createStripeGetTransport({})).toThrow(/CREDENTIAL_SOURCE_INVALID/);
    expect(() => createStripeGetTransport({ credentials: {} as any })).toThrow(/CREDENTIAL_SOURCE_INVALID/);
  });

  it('13. live-mode and malformed credentials are rejected, with the failed condition named and the value never', async () => {
    const cases: Array<[any, string]> = [
      [{ apiKey: ['sk', 'live', 'SyntheticLive0123456789'].join('_') }, 'CREDENTIAL_LIVE_MODE'], [{ apiKey: ['rk', 'live', 'SyntheticLive0123456789'].join('_') }, 'CREDENTIAL_LIVE_MODE'],
      [{ apiKey: 'pk_test_PublicKey0123456789' }, 'CREDENTIAL_MALFORMED'], [{ apiKey: '' }, 'CREDENTIAL_MALFORMED'], [{ apiKey: 5 }, 'CREDENTIAL_MALFORMED'], [{ validUntilMs: 1.5 }, 'CREDENTIAL_MALFORMED'],
      [{ accountId: 'acct_Other' }, 'CREDENTIAL_ACCOUNT_MISMATCH'], [{ workloadId: 'wl-other' }, 'CREDENTIAL_WORKLOAD_MISMATCH'], [{ validUntilMs: NOW }, 'CREDENTIAL_EXPIRED'], [{ validUntilMs: NOW - 1 }, 'CREDENTIAL_EXPIRED'], [null, 'CREDENTIAL_MISSING'],
    ];
    for (const [over, code] of cases) {
      const t = transportOver(undefined, credSource(over));
      let err: any; try { await t.transport.get('ACCOUNT_RETRIEVE_CURRENT', undefined, { accountId: ACCT, workloadId: WORKLOAD }); } catch (e) { err = e; }
      expect(err, code).toBeInstanceOf(CredentialDenied); expect(err.code, code).toBe(code); expect(t.calls, code).toEqual([]); // no request was made
      expect(err.message + JSON.stringify(err)).not.toMatch(/rk_|sk_|SyntheticLive/);
    }
    const unavailable = transportOver(undefined, { async resolve() { throw new Error('vault down'); } });
    await expect(unavailable.transport.get('ACCOUNT_RETRIEVE_CURRENT', undefined, { accountId: ACCT, workloadId: WORKLOAD })).rejects.toMatchObject({ code: 'CREDENTIAL_SOURCE_UNAVAILABLE' });
    await expect(transportOver().transport.get('ACCOUNT_RETRIEVE_CURRENT')).rejects.toMatchObject({ code: 'CREDENTIAL_BINDING_REQUIRED' }); // a binding is mandatory with a source
    // through the real provider: surfaced as a denial, request never made
    const live = transportOver(undefined, credSource({ apiKey: ['sk', 'live', 'SyntheticLive0123456789'].join('_') }));
    const r = rig({ transport: live.transport });
    expect(await r.run()).toEqual({ status: 'DENIED', reason: 'CREDENTIAL_LIVE_MODE' }); expect(live.calls).toEqual([]);
    expect(() => createStripeGetTransport({ apiKey: ['sk', 'live', 'SyntheticLive0123456789'].join('_') })).toThrow(/KEY_NOT_TEST_MODE/);
  });

  it('14. credential material never appears in errors, audits, results or proofs', async () => {
    const SECRET_BODY = 'SECRET-PAYLOAD-cus_private@example.com';
    const leaky = routedFetch(() => json({ error: { message: `Invalid API Key provided: ${GOOD_KEY}`, detail: SECRET_BODY } }, 401));
    const t = transportOver(leaky);
    const r = rig({ transport: t.transport });
    const out = await r.run();
    expect(out).toEqual({ status: 'PROVIDER_FAILURE', failureClass: 'PROVIDER_REJECTED' });
    const events: ReadAuditEvent[] = []; const store = createInMemoryProofStore();
    const proofOut = await captureProof({ transport: t.transport, gate: gateFor(AUTH, { mapping: MappingRegistry.catalog() }), store, clock: () => NOW, audit: e => events.push(e) }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' });
    const dumped = JSON.stringify([out, r.events, proofOut, events, store.list()]);
    expect(dumped).not.toMatch(/rk_test|SECRET-PAYLOAD|example\.com|Bearer|Invalid API Key/);
    const throwing = routedFetch(() => { throw new Error(`connect failed using ${GOOD_KEY}`); });
    const t2 = transportOver(throwing);
    let e: any; try { await t2.transport.get('ACCOUNT_RETRIEVE_CURRENT', undefined, { accountId: ACCT, workloadId: WORKLOAD }); } catch (x) { e = x; }
    expect(e.message + JSON.stringify(e) + String(e.stack).split('\n')[0]).not.toContain(GOOD_KEY);
  });

  it('15-17. unknown methods are rejected, write verbs and other paths are unreachable, and only the two fixed GET paths exist', async () => {
    for (const id of ['POST /v1/refunds', 'refunds.create', '__proto__', 'constructor', '', 42, null, undefined]) expect(await authorizeRead({ async lookup() { return []; } }, q({ methodId: id }), NOW)).toEqual({ allowed: false, reason: 'UNKNOWN_METHOD' });
    expect(await captureProof({ transport: new ScriptedReadTransport([account]), gate: gateFor(AUTH, { mapping: MappingRegistry.catalog() }), store: createInMemoryProofStore(), clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'REFUNDS_LIST' })).toEqual({ ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' });
    const t = transportOver();
    const b = { accountId: ACCT, workloadId: WORKLOAD };
    for (const bad of ['POST /v1/refunds', 'REFUNDS_LIST', 'INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'DISPUTES_LIST', '../../v1/charges', 'INVOICE_RETRIEVE ']) await expect(t.transport.get(bad as any, { invoiceId: 'in_1' }, b)).rejects.toMatchObject({ failureClass: 'DENIED' });
    for (const id of ['in_1/../../charges', 'in_1?expand[]=payments', 'cus_1', '', undefined]) await expect(t.transport.get('INVOICE_RETRIEVE', { invoiceId: id as any }, b)).rejects.toMatchObject({ failureClass: 'DENIED' });
    expect(t.calls).toEqual([]); // every refusal happened before a credential was even resolved
    expect((t.source as { resolved: number }).resolved).toBe(0);
    await t.transport.get('INVOICE_RETRIEVE', { invoiceId: 'in_1' }, b);
    expect(t.calls.map(c => c.url)).toEqual(['https://api.stripe.com/v1/invoices/in_1']);
    expect(Object.keys(t.transport).sort()).toEqual(['get', 'keyMode', 'networkSource']);
  });

  it('18-20. redirects are refused, a timeout is a safe failure, and an oversized response is rejected', async () => {
    const red = routedFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    const tr = transportOver(red);
    await expect(tr.transport.get('ACCOUNT_RETRIEVE_CURRENT', undefined, { accountId: ACCT, workloadId: WORKLOAD })).rejects.toMatchObject({ failureClass: 'PROVIDER_REJECTED' });
    expect(red.calls[0]!.init.redirect).toBe('error'); expect(red.calls).toHaveLength(1);
    const hung = routedFetch((_u, init) => new Promise<Response>((_res, rej) => { init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }));
    const th = createStripeGetTransport({ credentials: credSource(), fetchImpl: hung.fetchImpl, clock: () => NOW, timeoutMs: 20 });
    const outcome = await captureProof({ transport: th, gate: gateFor(AUTH, { mapping: MappingRegistry.catalog() }), store: createInMemoryProofStore(), clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' });
    expect(outcome).toEqual({ ok: false, kind: 'PROVIDER_FAILURE', failureClass: 'TIMEOUT' });
    const big = routedFetch(() => json({ pad: 'x'.repeat(5000) }));
    const tb = createStripeGetTransport({ credentials: credSource(), fetchImpl: big.fetchImpl, clock: () => NOW, maxBytes: 100 });
    await expect(tb.get('ACCOUNT_RETRIEVE_CURRENT', undefined, { accountId: ACCT, workloadId: WORKLOAD })).rejects.toMatchObject({ failureClass: 'RESPONSE_TOO_LARGE' });
    const declared = routedFetch(() => new Response('{}', { headers: { 'content-length': '999999' } }));
    const td = createStripeGetTransport({ credentials: credSource(), fetchImpl: declared.fetchImpl, clock: () => NOW, maxBytes: 100 });
    await expect(td.get('ACCOUNT_RETRIEVE_CURRENT', undefined, { accountId: ACCT, workloadId: WORKLOAD })).rejects.toMatchObject({ failureClass: 'RESPONSE_TOO_LARGE' });
  });

  it('16. no Stripe write path exists in any module, including the new authorization, mapping and proof modules', () => {
    const dir = resolve(__dirname);
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files).toEqual(expect.arrayContaining(['read-authorization.ts', 'read-gate.ts', 'mapping-authority.ts', 'proof-capture.ts', 'proof-fixtures.ts']));
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(/from 'stripe'|new Stripe\(/.test(text), `${f} imports the SDK client`).toBe(false);
      expect(/\bfetch\s*\(/.test(text) && f !== 'transport.ts', `${f} calls fetch`).toBe(false);
      expect(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(text), `${f} has a write verb`).toBe(false);
      expect(/\.(post|put|patch|del|delete)\(/.test(text), `${f} calls a write method`).toBe(false);
      expect(/refunds\.create|invoices\.(create|update|pay|finalize|void)|paymentIntents\.|subscriptions\.(update|cancel)/.test(text), `${f} names a Stripe write call`).toBe(false);
      expect(/process\.env|import\.meta\.env/.test(text), `${f} reads the environment`).toBe(false); // no environment variable can relax a restriction
    }
  });

  it('21. unsupported API versions are rejected for proofs and evidence reads, with zero requests', async () => {
    for (const apiVersion of ['2025-01-01.acacia', '', '__proto__', ` ${API}`]) {
      const t = new ScriptedReadTransport([account, invoice()]);
      expect(await captureProof({ transport: t, gate: gateFor(AUTH, { mapping: MappingRegistry.catalog() }), store: createInMemoryProofStore(), clock: () => NOW, audit: () => undefined, apiVersion }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' }), apiVersion)
        .toEqual({ ok: false, kind: 'DENIED', reason: 'UNSUPPORTED_API_VERSION' });
      expect(t.calls).toEqual([]);
      expect(await checkRead(gateFor(AUTH), { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', apiVersion, purpose: 'EVIDENCE' }, NOW)).toEqual({ ok: false, reason: 'MAPPING_UNSUPPORTED' }); // no mapping exists for that version
    }
  });
});

describe('C. field-mapping authority', () => {
  const catalog = MappingRegistry.catalog();
  it('the catalog is truthful: every mapped field is SDK_SCHEMA_UNPROVEN_LIVE or UNSUPPORTED, none is verified, each operation is covered, unsupported entries say why', () => {
    const entries = DEFAULT_MAPPING_CATALOG;
    expect(entries.every(e => e.status === 'SDK_SCHEMA_UNPROVEN_LIVE' || e.status === 'UNSUPPORTED')).toBe(true);
    expect(entries.some(e => e.status === 'TEST_MODE_VERIFIED' || e.status === 'SCHEMA_DRIFT')).toBe(false);
    for (const op of ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE', 'INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST'] as const) { expect(catalog.for(op, API).length, op).toBeGreaterThan(0); expect(catalog.operationStatus(op, API), op).toBe('SDK_SCHEMA_UNPROVEN_LIVE'); }
    for (const e of entries.filter(x => x.status === 'UNSUPPORTED')) expect(e.note && e.note.length > 10, e.sourceField).toBe(true);
    for (const e of entries) { expect(e.contractVersion).toBe('S08-STRIPE-MAPPING/1'); expect(e.apiVersion).toBe(API); expect(e.verifiedByProofId).toBeNull(); expect(e.destination.length).toBeGreaterThan(0); expect(e.completeness.length).toBeGreaterThan(0); }
    expect(new Set(entries.map(e => `${e.sourceOperation}|${e.sourceField}`)).size).toBe(entries.length); // no duplicates
    expect(catalog.operationStatus('INVOICE_RETRIEVE', '2025-01-01.acacia')).toBe('UNSUPPORTED');
    expect(Object.isFrozen(entries) && entries.every(e => Object.isFrozen(e))).toBe(true);
  });

  it('22. an unverified mapping cannot become verified: not by a fixture, a clone, a persisted claim without a real proof, a proof of another operation, or any non-real capture', async () => {
    // a persisted claim of verification is honoured only with a real proof of the same operation and version
    const claim = DEFAULT_MAPPING_CATALOG.map(e => (e.sourceOperation === 'INVOICE_RETRIEVE' && e.status === 'SDK_SCHEMA_UNPROVEN_LIVE' ? { ...e, status: 'TEST_MODE_VERIFIED', verifiedByProofId: 'p1' } : e));
    expect(MappingRegistry.load(claim)!.operationStatus('INVOICE_RETRIEVE', API)).toBe('SDK_SCHEMA_UNPROVEN_LIVE'); // no proof store
    expect(MappingRegistry.load(claim, { get: () => null })!.downgraded.length).toBeGreaterThan(0);
    for (const origin of ['INJECTED_TRANSPORT', 'SYNTHETIC_FIXTURE', 'FAKE'])
      expect(MappingRegistry.load(claim, { get: () => ({ captureOrigin: origin, methodId: 'INVOICE_RETRIEVE', apiVersion: API }) })!.operationStatus('INVOICE_RETRIEVE', API)).toBe('SDK_SCHEMA_UNPROVEN_LIVE');
    expect(MappingRegistry.load(claim, { get: () => ({ captureOrigin: 'REAL_NETWORK', methodId: 'ACCOUNT_RETRIEVE_CURRENT', apiVersion: API }) })!.operationStatus('INVOICE_RETRIEVE', API)).toBe('SDK_SCHEMA_UNPROVEN_LIVE');
    expect(MappingRegistry.load(claim, { get: () => ({ captureOrigin: 'REAL_NETWORK', methodId: 'INVOICE_RETRIEVE', apiVersion: '2025-01-01.acacia' }) })!.operationStatus('INVOICE_RETRIEVE', API)).toBe('SDK_SCHEMA_UNPROVEN_LIVE');
    expect(MappingRegistry.load(claim, { get: () => ({ captureOrigin: 'REAL_NETWORK', methodId: 'INVOICE_RETRIEVE', apiVersion: API }) })!.operationStatus('INVOICE_RETRIEVE', API)).toBe('TEST_MODE_VERIFIED'); // the one honoured case
    for (const bad of [null, {}, 'x', [{}], [{ ...DEFAULT_MAPPING_CATALOG[0], status: 'SOMETHING' }], [DEFAULT_MAPPING_CATALOG[0], DEFAULT_MAPPING_CATALOG[0]], [{ ...DEFAULT_MAPPING_CATALOG[0], contractVersion: 'old' }]] as any[]) expect(MappingRegistry.load(bad)).toBeNull();
    // fixtures covering every mapped field of every operation, built into proofs of every non-real origin, change nothing
    const responses = syntheticProofResponses();
    for (const origin of ['INJECTED_TRANSPORT', 'SYNTHETIC_FIXTURE'] as const) {
      let reg = catalog;
      for (const [op, body] of Object.entries(responses)) {
        const proof = await buildProof({ methodId: op as any, apiVersion: API, businessId: 'biz-1', accountId: PROOF_ACCOUNT_ID, workloadId: WORKLOAD, authorizationId: 'a', capturedAtMs: NOW, captureOrigin: origin, subject: 's', body, mapping: catalog });
        const r = applyProof(reg, proof); expect(r).toMatchObject({ note: 'ORIGIN_CANNOT_VERIFY', changes: [] }); reg = r.registry;
      }
      expect(reg.entries().every(e => e.status !== 'TEST_MODE_VERIFIED')).toBe(true);
    }
    const sealed = await buildProof({ methodId: 'ACCOUNT_RETRIEVE_CURRENT', apiVersion: API, businessId: 'biz-1', accountId: ACCT, workloadId: WORKLOAD, authorizationId: 'a', capturedAtMs: NOW, captureOrigin: 'REAL_NETWORK', subject: 's', body: account, mapping: catalog });
    for (const forged of [JSON.parse(JSON.stringify(sealed)), { ...sealed }, structuredClone(sealed), Object.create(sealed), null, 'x']) { expect(isSealedProof(forged)).toBe(false); expect(applyProof(catalog, forged)).toMatchObject({ note: 'PROOF_NOT_SEALED', changes: [] }); }
    expect(applyProof(catalog, { ...sealed, apiVersion: 'x' } as any).note).toBe('PROOF_NOT_SEALED');
  });

  it('23. mock proof records cannot establish real-provider authority: the gate still refuses evidence reads and the pipeline still rejects real evidence', async () => {
    const store = createInMemoryProofStore(); const t = new ScriptedReadTransport([account, invoice()]); // a fake: no network source at all
    const gate = gateFor(AUTH, { mapping: MappingRegistry.catalog() });
    const cap = await captureProof({ transport: t, gate, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1' });
    if (!cap.ok) throw new Error(`capture ${JSON.stringify(cap)}`);
    expect(cap.proof.captureOrigin).toBe('SYNTHETIC_FIXTURE');
    expect(applyProof(gate.mapping, cap.proof)).toMatchObject({ note: 'ORIGIN_CANNOT_VERIFY', changes: [] });
    expect(await checkRead(gate, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', apiVersion: API, purpose: 'EVIDENCE' }, NOW)).toEqual({ ok: false, reason: 'MAPPING_NOT_VERIFIED' });
    const injected = transportOver();
    const cap2 = await captureProof({ transport: injected.transport, gate, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1' });
    if (!cap2.ok) throw new Error('capture2'); expect(cap2.proof.captureOrigin).toBe('INJECTED_TRANSPORT'); expect(applyProof(gate.mapping, cap2.proof).changes).toEqual([]);
    // with the mapping still unverified no real EVIDENCE read happens at all
    const r = rig({ gate: gateFor(AUTH, { mapping: MappingRegistry.catalog() }) });
    expect(await r.run()).toEqual({ status: 'DENIED', reason: 'MAPPING_NOT_VERIFIED' }); expect(calls(r.transport)).toEqual([]);
  });

  it('a REAL_NETWORK proof (the platform fetch path, stubbed here) is the only thing that verifies a mapping, field by field, and later evidence can demote it', async () => {
    const real = routedFetch(stripeRoutes());
    vi.stubGlobal('fetch', real.fetchImpl);
    const transport = createStripeGetTransport({ credentials: credSource(), clock: () => NOW }); // no fetchImpl: the platform fetch
    expect(transport.networkSource).toBe('GLOBAL_FETCH');
    const store = createInMemoryProofStore(); const gate = gateFor(AUTH, { mapping: MappingRegistry.catalog() });
    const events: ReadAuditEvent[] = [];
    const a = await captureProof({ transport, gate, store, clock: () => NOW, audit: e => events.push(e) }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' });
    const i = await captureProof({ transport, gate, store, clock: () => NOW, audit: e => events.push(e) }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1' });
    if (!a.ok || !i.ok) throw new Error('capture failed');
    expect(a.proof.captureOrigin).toBe('REAL_NETWORK'); expect(i.proof).toMatchObject({ captureOrigin: 'REAL_NETWORK', mode: 'test', accountVerified: true, accountId: ACCT, workloadId: WORKLOAD, authorizationId: 'auth-INVOICE_RETRIEVE' });
    let reg = gate.mapping;
    const ra = applyProof(reg, a.proof); expect(ra.note).toBe('APPLIED'); expect(ra.changes.map(c => c.to)).toEqual(['TEST_MODE_VERIFIED', 'TEST_MODE_VERIFIED']); reg = ra.registry;
    expect(reg.operationStatus('ACCOUNT_RETRIEVE_CURRENT', API)).toBe('TEST_MODE_VERIFIED'); expect(reg.operationStatus('INVOICE_RETRIEVE', API)).toBe('SDK_SCHEMA_UNPROVEN_LIVE');
    const ri = applyProof(reg, i.proof); reg = ri.registry;
    // fields this one response did not exhibit (for example a null-able parent, or an empty variant) stay unproven: one response never verifies what it did not show
    const stillUnproven = reg.for('INVOICE_RETRIEVE', API).filter(e => e.status === 'SDK_SCHEMA_UNPROVEN_LIVE').map(e => e.sourceField);
    expect(ri.changes.length).toBeGreaterThan(5); expect(reg.entries().filter(e => e.status === 'TEST_MODE_VERIFIED').every(e => e.verifiedByProofId !== null)).toBe(true);
    expect(reg.entries().filter(e => e.status === 'UNSUPPORTED').every(e => e.verifiedByProofId === null)).toBe(true);
    expect(registryUnchangedOutsideOps(gate.mapping, reg, ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'])).toBe(true); // the four unauthorized operations are untouched
    void stillUnproven;
    // idempotent application
    expect(applyProof(reg, i.proof).changes).toEqual([]);
    // later real evidence of a different type demotes a verified field to SCHEMA_DRIFT, and the evidence gate then refuses
    const drifted = await buildProof({ methodId: 'ACCOUNT_RETRIEVE_CURRENT', apiVersion: API, businessId: 'biz-1', accountId: ACCT, workloadId: WORKLOAD, authorizationId: 'a', capturedAtMs: NOW + 1, captureOrigin: 'REAL_NETWORK', subject: 's', body: { object: 'account', id: 5 }, mapping: reg });
    const rd = applyProof(reg, drifted); expect(rd.changes).toEqual([{ key: `${API}|ACCOUNT_RETRIEVE_CURRENT|id`, from: 'TEST_MODE_VERIFIED', to: 'SCHEMA_DRIFT' }]);
    expect(rd.registry.operationStatus('ACCOUNT_RETRIEVE_CURRENT', API)).toBe('SCHEMA_DRIFT');
    expect(await checkRead({ ...gate, mapping: rd.registry }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT', apiVersion: API, purpose: 'EVIDENCE' }, NOW)).toEqual({ ok: false, reason: 'MAPPING_DRIFT' });
    expect(real.calls.every(c => c.init.method === 'GET')).toBe(true);
  });

  it('24. schema drift is classified: wrong types and unknown enum values are TYPE_MISMATCH / ENUM_UNKNOWN, absent fields are ABSENT, extra fields are tolerated; synthetic evidence reports drift but changes nothing', async () => {
    const res = syntheticProofResponses();
    const evalOp = (op: any, body: unknown) => evaluateCompatibility(observeShape(body, catalog.for(op, API)), catalog.for(op, API));
    const ok = evalOp('INVOICE_RETRIEVE', res.INVOICE_RETRIEVE);
    expect(ok.filter(c => c.result === 'COMPATIBLE').length).toBeGreaterThan(10); expect(ok.some(c => c.result === 'TYPE_MISMATCH' || c.result === 'ENUM_UNKNOWN')).toBe(false);
    const pick = (r: readonly { sourceField: string; result: string }[], f: string) => r.find(c => c.sourceField === f)?.result;
    const mutated = evalOp('INVOICE_RETRIEVE', { ...res.INVOICE_RETRIEVE, status: 'frozen', amount_due: '2700', currency: 5, livemode: 'false', surprise: { a: 1 } });
    expect(pick(mutated, 'status')).toBe('ENUM_UNKNOWN'); expect(pick(mutated, 'amount_due')).toBe('TYPE_MISMATCH'); expect(pick(mutated, 'currency')).toBe('TYPE_MISMATCH'); expect(pick(mutated, 'livemode')).toBe('TYPE_MISMATCH');
    expect(pick(mutated, 'total')).toBe('COMPATIBLE');
    const missing = evalOp('INVOICE_RETRIEVE', (() => { const c: any = { ...res.INVOICE_RETRIEVE }; delete c.customer; return c; })()); expect(pick(missing, 'customer')).toBe('ABSENT');
    expect(pick(evalOp('INVOICE_RETRIEVE', { ...res.INVOICE_RETRIEVE, parent: null }), 'parent.subscription_details.subscription')).toBe('ABSENT');
    expect(pick(evalOp('INVOICE_RETRIEVE', { ...res.INVOICE_RETRIEVE, status_transitions: { paid_at: null, voided_at: null } }), 'status_transitions.paid_at')).toBe('COMPATIBLE'); // nullable
    expect(pick(evalOp('INVOICE_RETRIEVE', { ...res.INVOICE_RETRIEVE, customer: null }), 'customer')).toBe('TYPE_MISMATCH'); // not nullable
    expect(pick(evalOp('INVOICE_RETRIEVE', { ...res.INVOICE_RETRIEVE, customer: { id: 'cus_1' } }), 'customer')).toBe('COMPATIBLE'); // an expanded reference
    for (const [op, f, bad, expected] of [['REFUNDS_LIST', 'data[].status', 'reversed', 'ENUM_UNKNOWN'], ['DISPUTES_LIST', 'data[].status', 'closed', 'ENUM_UNKNOWN'], ['PAYMENT_RETRIEVE', 'data[].status', 'refunded', 'ENUM_UNKNOWN'], ['INVOICE_LINES_LIST', 'data[].parent.type', 'schedule_details', 'ENUM_UNKNOWN']] as const) {
      const body: any = JSON.parse(JSON.stringify((res as any)[op])); const path = f.replace('data[].', '').split('.'); let o = body.data[0]; for (const p of path.slice(0, -1)) o = o[p]; o[path[path.length - 1]!] = bad;
      expect(pick(evalOp(op, body), f), `${op} ${f}`).toBe(expected);
    }
    // the shape keeps no values except enum-typed ones; metadata keys are never recorded
    const sh = observeShape({ ...res.INVOICE_LINES_LIST, data: [{ ...res.INVOICE_LINES_LIST.data[1], metadata: { customer_secret_key: 'v' } }] }, catalog.for('INVOICE_LINES_LIST', API));
    expect(JSON.stringify(sh)).not.toMatch(/customer_secret_key|il_Proof|ii_Proof|sub_Proof|3000|-300/);
    expect(sh.observations['data[].parent.type']!.enumValues).toEqual(['invoice_item_details']);
    // a synthetic proof of drifted data reports drift and changes no status
    const proof = await buildProof({ methodId: 'INVOICE_RETRIEVE', apiVersion: API, businessId: 'biz-1', accountId: ACCT, workloadId: WORKLOAD, authorizationId: 'a', capturedAtMs: NOW, captureOrigin: 'SYNTHETIC_FIXTURE', subject: 'in_1', body: { ...res.INVOICE_RETRIEVE, status: 'frozen' }, mapping: catalog });
    expect(proof.drift).toEqual(['ENUM_UNKNOWN:status']); expect(applyProof(catalog, proof).changes).toEqual([]); expect(catalog.operationStatus('INVOICE_RETRIEVE', API)).toBe('SDK_SCHEMA_UNPROVEN_LIVE');
  });
});

const registryUnchangedOutsideOps = (before: MappingRegistry, after: MappingRegistry, ops: readonly string[]) =>
  before.entries().every((e, i) => ops.includes(e.sourceOperation) || (after.entries()[i]!.status === e.status && after.entries()[i]!.verifiedByProofId === e.verifiedByProofId));

describe('D. proof capture, gate purposes and idempotency', () => {
  const gate = () => gateFor(AUTH, { mapping: MappingRegistry.catalog() });
  const cap = (g: ReturnType<typeof gate>, t: StripeReadTransport, store = createInMemoryProofStore(), over: Record<string, unknown> = {}) =>
    captureProof({ transport: t, gate: g, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1', ...over } as any);

  it('the gate purposes differ: PROOF may read while a mapping is unproven or drifted, EVIDENCE needs a verified mapping, and neither reads an unsupported one', async () => {
    const g = gate();
    const at = (purpose: 'PROOF' | 'EVIDENCE', mapping: MappingRegistry, id: any = 'INVOICE_RETRIEVE') => checkRead({ ...g, mapping }, { businessId: 'biz-1', accountId: ACCT, methodId: id, apiVersion: API, purpose }, NOW);
    expect(await at('PROOF', MappingRegistry.catalog())).toMatchObject({ ok: true, authorizationId: 'auth-INVOICE_RETRIEVE' });
    expect(await at('EVIDENCE', MappingRegistry.catalog())).toEqual({ ok: false, reason: 'MAPPING_NOT_VERIFIED' });
    expect(await at('EVIDENCE', verifiedMapping())).toMatchObject({ ok: true });
    expect(await at('PROOF', verifiedMapping())).toMatchObject({ ok: true });
    const drift = MappingRegistry.load(DEFAULT_MAPPING_CATALOG.map(e => (e.sourceOperation === 'INVOICE_RETRIEVE' && e.sourceField === 'status' ? { ...e, status: 'SCHEMA_DRIFT' } : e)))!;
    expect(await at('PROOF', drift)).toMatchObject({ ok: true }); expect(await at('EVIDENCE', drift)).toEqual({ ok: false, reason: 'MAPPING_DRIFT' });
    const none = MappingRegistry.load([])!;
    expect(await at('PROOF', none)).toEqual({ ok: false, reason: 'MAPPING_UNSUPPORTED' }); expect(await at('EVIDENCE', none)).toEqual({ ok: false, reason: 'MAPPING_UNSUPPORTED' });
    for (const purpose of ['READ', '', undefined, null] as any[]) expect(await at(purpose, verifiedMapping())).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
    expect(await checkRead(null as any, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', apiVersion: API, purpose: 'PROOF' }, NOW)).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
  });

  it('25-26. wrong-account and wrong-mode response evidence is rejected and never stored', async () => {
    const store = createInMemoryProofStore();
    expect(await cap(gate(), new ScriptedReadTransport([{ object: 'account', id: 'acct_Other' }, invoice()]), store)).toEqual({ ok: false, kind: 'DENIED', reason: 'ACCOUNT_MISMATCH' });
    for (const bad of [null, {}, { object: 'customer', id: ACCT }, { object: 'account' }, { object: 'account', id: 5 }]) expect(await cap(gate(), new ScriptedReadTransport([bad, invoice()]), store)).toEqual({ ok: false, kind: 'DENIED', reason: 'ACCOUNT_RESPONSE_INVALID' });
    for (const livemode of [true, undefined, null, 'false', 0]) expect(await cap(gate(), new ScriptedReadTransport([account, invoice({ livemode })]), store)).toEqual({ ok: false, kind: 'DENIED', reason: 'REALM_MISMATCH' });
    expect(await cap(gate(), new ScriptedReadTransport([account, invoice({ id: 'in_other' })]), store)).toEqual({ ok: false, kind: 'DENIED', reason: 'INVOICE_IDENTITY_MISMATCH' });
    expect(await cap(gate(), new ScriptedReadTransport([account, { ...invoice(), object: 'charge' }]), store)).toEqual({ ok: false, kind: 'DENIED', reason: 'OBJECT_MISMATCH' });
    expect(store.list()).toEqual([]);
    // the account is verified before the target is read: a wrong account never costs an invoice request
    const t = new ScriptedReadTransport([{ object: 'account', id: 'acct_Other' }, invoice()]); await cap(gate(), t, store);
    expect(t.calls.map(c => c.method)).toEqual(['ACCOUNT_RETRIEVE_CURRENT']);
    for (const bad of [{ invoiceId: 'cus_1' }, { invoiceId: undefined }, { accountId: 'x' }, { businessId: '' }, { methodId: 'PAYMENT_RETRIEVE' }]) expect(await cap(gate(), new ScriptedReadTransport([account, invoice()]), store, bad)).toEqual({ ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' });
  });

  it('27. duplicate proof capture is idempotent: one stored record, the same identity, a duplicate flag, no second record for later captures of the same response', async () => {
    const store = createInMemoryProofStore(); const g = gate();
    const a = await cap(g, new ScriptedReadTransport([account, invoice()]), store);
    const b = await cap(g, new ScriptedReadTransport([account, invoice()]), store);
    if (!a.ok || !b.ok) throw new Error('capture failed');
    expect(a.duplicate).toBe(false); expect(b.duplicate).toBe(true);
    expect(b.proof.proofId).toBe(a.proof.proofId); expect(b.proof).toBe(a.proof); expect(store.list()).toHaveLength(1);
    const other = await cap(g, new ScriptedReadTransport([account, invoice({ amount_due: 2800, amount_paid: 2800, total: 2800 })]), store);
    if (!other.ok) throw new Error('capture failed'); expect(other.proof.proofId).not.toBe(a.proof.proofId); expect(store.list()).toHaveLength(2);
    expect(() => store.append({ ...a.proof } as any)).toThrow(/PROOF_NOT_SEALED/); // a record that was not produced by the proof module cannot be appended
    expect(Object.keys(store).sort()).toEqual(['append', 'get', 'list']); // append-only: no update, no delete
    // the stored record is minimal and immutable
    const text = JSON.stringify(a.proof);
    expect(text).not.toMatch(/in_1"|cus_1|sub_1|2700|il_base|SyntheticKey/); expect(Object.isFrozen(a.proof)).toBe(true);
    expect(a.proof).toMatchObject({ apiVersion: API, mode: 'test', accountVerified: true, capturedAtMs: NOW, mappingContractVersion: 'S08-STRIPE-MAPPING/1' });
    expect(a.proof.responseFingerprint).toMatch(/^[0-9a-f]{64}$/); expect(a.proof.shapeFingerprint).toMatch(/^[0-9a-f]{64}$/); expect(a.proof.subjectHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('proof capture needs its own authorization: without a record for the exact method, with a revoked or wrong-workload record, or an unavailable store, no request is made', async () => {
    const tries: Array<[ReturnType<typeof gateFor>, string]> = [[gateFor(null, { mapping: MappingRegistry.catalog() }), 'AUTHORIZATION_MISSING'], [gateFor({ ...AUTH, revoked: true }, { mapping: MappingRegistry.catalog() }), 'AUTHORIZATION_REVOKED'],
      [Object.assign(gateFor(AUTH, { mapping: MappingRegistry.catalog() }), { workloadId: 'wl-other' }), 'WORKLOAD_MISMATCH'], [Object.assign(gateFor(AUTH, { mapping: MappingRegistry.catalog() }), { store: unavailableAuthorizationStore }), 'AUTHORIZATION_STORE_UNAVAILABLE'],
      [gateFor({ ...AUTH, methods: ['ACCOUNT_RETRIEVE_CURRENT'] }, { mapping: MappingRegistry.catalog() }), 'AUTHORIZATION_MISSING']];
    for (const [g, reason] of tries) { const t = new ScriptedReadTransport([account, invoice()]); expect(await cap(g, t), reason).toEqual({ ok: false, kind: 'DENIED', reason }); expect(t.calls.length, reason).toBeLessThanOrEqual(1); }
    const t = transportOver(undefined, credSource({ workloadId: 'wl-other' }));
    expect(await cap(gate(), t.transport)).toEqual({ ok: false, kind: 'DENIED', reason: 'CREDENTIAL_WORKLOAD_MISMATCH' }); expect(t.calls).toEqual([]);
  });
});

describe('E. the boundary end to end (synthetic)', () => {
  it('29. a valid synthetic authorized read goes through authorization, mapping gate, bound credential and restricted transport into the normalizer; the evidence is real-origin and so is rejected for settlement', async () => {
    const t = transportOver();
    const r = rig({ transport: t.transport });
    const out = await r.run();
    if (out.status !== 'REJECTED') throw new Error(`expected REJECTED, got ${JSON.stringify(out).slice(0, 200)}`);
    expect(out.evidence.accountId).toMatchObject({ state: 'VERIFIED', value: ACCT, origin: 'STRIPE_TEST_READ' });
    expect(out.evidence.invoice.status).toMatchObject({ state: 'VERIFIED', value: 'paid' }); expect(out.evidence.invoice.amounts.state).toBe('VERIFIED'); // the normalizer ran
    expect(t.calls.map(c => c.url)).toEqual(['https://api.stripe.com/v1/account', 'https://api.stripe.com/v1/invoices/in_1', 'https://api.stripe.com/v1/invoices/in_1']);
    expect(t.calls.every(c => c.init.method === 'GET' && c.init.body === undefined)).toBe(true);
    expect(out.completeness.blockers).toContain('REAL_EVIDENCE_NOT_AUTHORIZED_FOR_SETTLEMENT');
    expect(r.events.map(e => e.event)).toContain('stripe_read.success');
    expect(JSON.stringify([out, r.events])).not.toContain(GOOD_KEY);
  });

  it('30-31. a complete synthetic acquisition still reaches the D1/D3 classifiers, and a real-origin bundle stays prohibited from the recordable path', async () => {
    const h = invocationHarness();
    const pipeline = new EvidenceAcquisitionPipeline<string>({ provider: mockProvider(), config: CONFIG, clock: () => NOW, audit: () => undefined, resolveBinding: async () => binding() });
    void h;
    const ok = await pipeline.run(REQ);
    if (ok.status !== 'CLASSIFIED') throw new Error('expected CLASSIFIED');
    expect(ok.classification.settlement).toMatchObject({ verdict: 'ELIGIBLE', grantsFinancialAuthority: false }); expect(ok.classification.refundDispute?.classification).toBe('NO_REFUND');
    expect(ok.recordableEvidence?.provenance.evidenceKind).toBe('MOCK_SYNTHETIC');
    const real = rig(); const out = await real.run();
    if (out.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect('recordableEvidence' in out).toBe(false); expect(out.classification?.settlementEvidence).toBeNull();
    expect(out.classification?.settlement.reasonCodes).toEqual(['EVIDENCE_KIND_UNSUPPORTED']);
  });
});
