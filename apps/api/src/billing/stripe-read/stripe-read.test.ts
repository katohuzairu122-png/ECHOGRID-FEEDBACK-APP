/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import {
  buildMockEvidence, canonicalJson, classifyBundle, createStripeGetTransport, decideCapability, disputeState, ProviderReadError, READ_METHODS, refundExtent, ScriptedReadTransport,
  sealedOriginOf, StripeReadConfigError, StripeReadOnlyEvidenceAdapter, syntheticStripeInvoice, TrustedStripeEvidenceService,
  type MockEvidenceSpec, type ReadAuditEvent, type ReadAuthorization, type TrustedInvoiceScope,
} from './index';
import { canonicalPrivateInvocation, type InvocationPolicy, type InvocationRequest } from '../private-stripe-verifier-invocation.contract';
import { benefitIdempotencyKey, type SettlementClassifierContext } from '../settlement-eligibility.classifier';
import type { RefundDisputeContext } from '../refund-dispute.classifier';

/**
 * S08-D1D3-DEV-06 acceptance tests. Synthetic fixtures and a scripted/fake transport only: there is no network, no real key and no Stripe account. The numeric values (freshness window,
 * policy instant) are TEST FIXTURES, not policy.
 */
const ACCT = 'acct_TestSyntheticAccount1';
const KEY_TEXT = 'rk_test_SyntheticKeyMaterial0123456789';
const NOW = 1_700_001_000_000; // after the fixture invoice was paid (1_700_000_100 s)
const scope: TrustedInvoiceScope = { businessId: 'biz-1', invoiceId: 'in_1', customerId: 'cus_1', subscriptionId: 'sub_1' };
const AUTH: ReadAuthorization = { approved: true, revoked: false, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventoryRevision: 'rev-synthetic-1', accountId: ACCT, realm: 'test',
  methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'], expiresAtMs: NOW + 3_600_000 };
const account = { object: 'account', id: ACCT };
const inv = (over: Record<string, unknown> = {}) => syntheticStripeInvoice(scope, over);
// the synthetic invoice: base 10000 and benefit -300 would not sum to 9700 with a 3 % benefit, so fixtures below use base 3000 / benefit -300 / total 2700
const fixtureInvoice = (over: Record<string, unknown> = {}) => inv({ amount_due: 2700, amount_paid: 2700, amount_remaining: 0, total: 2700,
  lines: { object: 'list', has_more: false, data: [{ id: 'il_base', amount: 3000, currency: 'usd' }, { id: 'il_ben', amount: -300, currency: 'usd' }] }, ...over });
const KEY = benefitIdempotencyKey('res-1');

function adapterFor(responses: unknown[], auth: ReadAuthorization | null = AUTH, now = NOW) {
  const transport = new ScriptedReadTransport(responses);
  const events: ReadAuditEvent[] = [];
  return { transport, events, adapter: new StripeReadOnlyEvidenceAdapter({ transport, authorization: auth, clock: () => now, audit: e => events.push(e) }) };
}
const D = (c: string) => c.repeat(64).slice(0, 64);
const ctx = (over: Record<string, unknown> = {}): SettlementClassifierContext => ({
  nowMs: NOW, policy: { version: 'PC-BENEFIT/1', effectiveFromMs: 1_000, freshnessWindowMs: 3_600_000 },
  expected: { businessId: 'biz-1', reservationId: 'res-1', intentRef: 'intent-1', invoiceRef: 'in_1', customerRef: 'cus_1', subscriptionRef: 'sub_1', currency: 'usd', providerAccountId: ACCT, providerMode: 'test',
    reservationExpiresAtMs: NOW + 86_400_000,
    frozenAllocation: { artifactVersion: 1, allocationPolicyVersion: 'S08-AGG-ROUND/1', benefitPolicyVersion: 'PC-BENEFIT/1', businessId: 'biz-1', invoiceRef: 'in_1', currency: 'usd', eligibleBaseMinor: 3000,
      eligibleCreditBalance: 1, unitsToApply: 1, aggregateBenefitMinor: 300, percentApplied: 1,
      allocations: [{ reservationId: 'res-1', invoiceIntentRef: 'intent-1', units: 1, benefitMinor: 300, providerIdempotencyKey: KEY }], allocationDigest: D('a'), providerVerified: false, consumptionAuthorized: false } as any },
  ...over,
} as SettlementClassifierContext);
const binding = { businessId: 'biz-1', reservationId: 'res-1', intentRef: 'intent-1' };
const rdCtx = (): RefundDisputeContext => ({ nowMs: NOW, policy: { version: 'PC-BENEFIT/1', freshnessWindowMs: 3_600_000 },
  expected: { businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', providerAccountId: ACCT, providerMode: 'test', consumedAtMs: null } });
const spec = (over: Partial<MockEvidenceSpec> = {}): MockEvidenceSpec => ({
  scope, accountId: ACCT, observedAtMs: NOW - 1_000, invoiceBefore: fixtureInvoice(),
  lineAttribution: [{ lineRef: 'il_base', category: 'recurring_base', parentItemRef: null, parentItemKey: null }, { lineRef: 'il_ben', category: 'benefit', parentItemRef: 'ii_ben', parentItemKey: KEY }],
  billingInterval: 'month', benefitItem: { itemRef: 'ii_ben', invoiceRef: 'in_1', idempotencyKey: KEY, amountMinor: -300, currency: 'usd', discountable: false }, cancellation: 'none',
  settlingPayment: { ref: 'pi_1', source: 'stripe_payment' }, refunds: 'absent', disputes: 'absent', ...over,
});
const mock = async (over: Partial<MockEvidenceSpec> = {}) => { const r = await buildMockEvidence(spec(over)); if (!r.ok) throw new Error(`mock denied ${r.denied}`); return r.evidence; };
const classify = async (over: Partial<MockEvidenceSpec> = {}, withD3 = true) => classifyBundle(ctx(), await mock(over), binding, withD3 ? rdCtx() : null);

describe('capability registry', () => {
  it('every registry method is GET-only and test-mode-only, with a schema, contract, failure classes and audit events; exactly two are performable', () => {
    for (const m of Object.values(READ_METHODS)) {
      expect(m.http).toBe('GET'); expect(m.testModeOnly).toBe(true);
      expect(m.requestSchema.length).toBeGreaterThan(0); expect(m.responseContract.length).toBeGreaterThan(0);
      expect(m.failureClasses.length).toBeGreaterThan(0); expect(m.auditEvents).toContain('stripe_read.denied');
    }
    expect(Object.values(READ_METHODS).filter(m => m.authorization === 'APPROVAL_REQUIRED').map(m => m.id).sort()).toEqual(['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE']);
    expect(Object.isFrozen(READ_METHODS)).toBe(true);
  });

  it('3. unapproved and unknown read methods are rejected even when an authorization lists them; a missing, expired, revoked or non-test authorization disables the approved ones', () => {
    for (const id of ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST']) {
      expect(decideCapability(id, { ...AUTH, methods: [id as any, 'ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] }, NOW)).toEqual({ allowed: false, reason: 'METHOD_NOT_AUTHORIZED' });
    }
    for (const id of ['POST /v1/refunds', 'refunds.create', '__proto__', 'constructor', 'toString', '', 42, null, undefined]) expect(decideCapability(id, AUTH, NOW)).toEqual({ allowed: false, reason: 'UNKNOWN_METHOD' });
    expect(decideCapability('INVOICE_RETRIEVE', AUTH, NOW)).toMatchObject({ allowed: true });
    expect(decideCapability('INVOICE_RETRIEVE', null, NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_MISSING' });
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, approved: false }, NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_INVALID' });
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, revoked: true }, NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_REVOKED' });
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, expiresAtMs: NOW }, NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_EXPIRED' });
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, realm: 'live' as any }, NOW)).toEqual({ allowed: false, reason: 'REALM_NOT_TEST' });
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, accountId: 'not-an-account' }, NOW)).toEqual({ allowed: false, reason: 'ACCOUNT_NOT_APPROVED' });
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, methods: ['ACCOUNT_RETRIEVE_CURRENT'] }, NOW)).toEqual({ allowed: false, reason: 'METHOD_NOT_APPROVED' });
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, inventoryRecordId: 'something-else' as any }, NOW)).toEqual({ allowed: false, reason: 'AUTHORIZATION_INVALID' });
  });

  it('with no authorization the adapter makes no provider call and audits the denial', async () => {
    const { adapter, transport, events } = adapterFor([account, fixtureInvoice()], null);
    expect(await adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'AUTHORIZATION_MISSING' });
    expect(transport.calls).toEqual([]);
    expect(events.map(e => e.event)).toEqual(['stripe_read.denied']);
  });
});

describe('read-only transport', () => {
  const fakeFetch = (handler: (url: string, init: any) => Promise<Response>) => { const calls: Array<{ url: string; init: any }> = []; return { calls, fetchImpl: (async (u: any, init: any) => { calls.push({ url: String(u), init }); return handler(String(u), init); }) as unknown as typeof fetch }; };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('4. only GET on two fixed paths is possible; no write method, generic path or other verb exists', async () => {
    const f = fakeFetch(async () => json(account));
    const t = createStripeGetTransport({ apiKey: KEY_TEXT, fetchImpl: f.fetchImpl });
    expect(Object.keys(t).sort()).toEqual(['get', 'keyMode']);
    expect(Object.isFrozen(t)).toBe(true);
    await t.get('ACCOUNT_RETRIEVE_CURRENT');
    await t.get('INVOICE_RETRIEVE', { invoiceId: 'in_1' });
    expect(f.calls.map(c => [c.init.method, c.url])).toEqual([['GET', 'https://api.stripe.com/v1/account'], ['GET', 'https://api.stripe.com/v1/invoices/in_1']]);
    for (const c of f.calls) { expect(c.init.body).toBeUndefined(); expect(c.init.redirect).toBe('error'); expect(c.init.headers['Stripe-Version']).toBe('2026-05-27.dahlia'); expect(c.init.headers['Stripe-Account']).toBeUndefined(); }
    // anything that is not one of the two method ids, or carries a malformed invoice id, is refused before any request
    for (const bad of ['POST /v1/refunds', 'REFUNDS_LIST', 'INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'DISPUTES_LIST', '../../v1/charges', 'INVOICE_RETRIEVE ']) {
      await expect(t.get(bad as any, { invoiceId: 'in_1' })).rejects.toMatchObject({ failureClass: 'DENIED' });
    }
    for (const id of ['in_1/../../charges', 'in_1?expand[]=payments', 'cus_1', '', 'in_', undefined]) await expect(t.get('INVOICE_RETRIEVE', { invoiceId: id as any })).rejects.toMatchObject({ failureClass: 'DENIED' });
    expect(f.calls).toHaveLength(2);
    expect((t as any).post ?? (t as any).request ?? (t as any).delete ?? (t as any).put ?? (t as any).patch).toBeUndefined();
    const names = [...Object.getOwnPropertyNames(StripeReadOnlyEvidenceAdapter.prototype), ...Object.getOwnPropertyNames(TrustedStripeEvidenceService.prototype)];
    expect(names.filter(n => /post|put|patch|delete|request|create|update|refund|write|send|execute/i.test(n))).toEqual([]);
  });

  it('5. live-mode credentials are refused at construction without echoing them, and a live or unknown-mode invoice is refused', async () => {
    // built at runtime: a literal live-key-shaped string would (rightly) trip the repository's static credential scan
    const liveShaped = ['sk', 'live', 'SyntheticLive0123456789'].join('_');
    for (const k of [liveShaped, ['rk', 'live', 'SyntheticLive0123456789'].join('_'), 'pk_test_SyntheticPublic0123456789', 'whsec_SyntheticSecret0123456789', '', 'rk_test_', 'sk_test_short', undefined]) {
      let err: unknown; try { createStripeGetTransport({ apiKey: k as any }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(StripeReadConfigError);
      expect(String((err as Error).message) + JSON.stringify(err)).not.toContain(String(k).length > 8 ? String(k) : '\u0000');
    }
    for (const livemode of [true, undefined, null, 'false', 0]) {
      const { adapter } = adapterFor([account, fixtureInvoice({ livemode })]);
      expect(await adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'REALM_MISMATCH' });
    }
    expect(decideCapability('INVOICE_RETRIEVE', { ...AUTH, realm: 'live' as any }, NOW)).toEqual({ allowed: false, reason: 'REALM_NOT_TEST' });
  });

  it('19. a provider timeout, a network failure and a rate limit are safe failures with no evidence', async () => {
    for (const failureClass of ['TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'PROVIDER_ERROR', 'PROVIDER_REJECTED', 'MALFORMED_RESPONSE', 'RESPONSE_TOO_LARGE'] as const) {
      const { adapter, events } = adapterFor([{ throws: failureClass }]);
      expect(await adapter.acquire(scope)).toEqual({ ok: false, kind: 'PROVIDER_FAILURE', failureClass });
      expect(events.at(-1)).toMatchObject({ event: 'stripe_read.failure', reason: failureClass });
    }
    // the real transport: a hung request is aborted by its own timer
    const hung = fakeFetch((_u, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }));
    const t = createStripeGetTransport({ apiKey: KEY_TEXT, fetchImpl: hung.fetchImpl, timeoutMs: 25 });
    await expect(t.get('ACCOUNT_RETRIEVE_CURRENT')).rejects.toMatchObject({ failureClass: 'TIMEOUT' });
    const net = createStripeGetTransport({ apiKey: KEY_TEXT, fetchImpl: fakeFetch(async () => { throw new Error('socket hang up'); }).fetchImpl });
    await expect(net.get('ACCOUNT_RETRIEVE_CURRENT')).rejects.toMatchObject({ failureClass: 'NETWORK' });
    for (const [status, cls] of [[429, 'RATE_LIMITED'], [500, 'PROVIDER_ERROR'], [503, 'PROVIDER_ERROR'], [401, 'PROVIDER_REJECTED'], [404, 'PROVIDER_REJECTED'], [302, 'PROVIDER_REJECTED']] as const) {
      const t2 = createStripeGetTransport({ apiKey: KEY_TEXT, fetchImpl: fakeFetch(async () => new Response('{}', { status })).fetchImpl });
      await expect(t2.get('ACCOUNT_RETRIEVE_CURRENT')).rejects.toMatchObject({ failureClass: cls });
    }
    const bad = createStripeGetTransport({ apiKey: KEY_TEXT, fetchImpl: fakeFetch(async () => new Response('not json')).fetchImpl });
    await expect(bad.get('ACCOUNT_RETRIEVE_CURRENT')).rejects.toMatchObject({ failureClass: 'MALFORMED_RESPONSE' });
    const big = createStripeGetTransport({ apiKey: KEY_TEXT, maxBytes: 100, fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ pad: 'x'.repeat(500) }))).fetchImpl });
    await expect(big.get('ACCOUNT_RETRIEVE_CURRENT')).rejects.toMatchObject({ failureClass: 'RESPONSE_TOO_LARGE' });
  });

  it('20. provider errors, bodies and audit events never contain the credential or the response body', async () => {
    const SECRET_BODY = 'SECRET-PAYLOAD-cus_private_name@example.com';
    const leaky = fakeFetch(async () => new Response(JSON.stringify({ error: { message: `Invalid API Key provided: ${KEY_TEXT}`, detail: SECRET_BODY } }), { status: 401 }));
    const t = createStripeGetTransport({ apiKey: KEY_TEXT, fetchImpl: leaky.fetchImpl });
    let err: any; try { await t.get('ACCOUNT_RETRIEVE_CURRENT'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderReadError);
    for (const text of [err.message, JSON.stringify(err), String(err.stack ?? '').split('\n')[0]!]) { expect(text).not.toContain(KEY_TEXT); expect(text).not.toContain('SECRET-PAYLOAD'); }
    expect(err.message).toBe('STRIPE_READ_PROVIDER_REJECTED');
    const throwing = createStripeGetTransport({ apiKey: KEY_TEXT, fetchImpl: fakeFetch(async () => { throw new Error(`connect ECONNREFUSED using ${KEY_TEXT}`); }).fetchImpl });
    let err2: any; try { await throwing.get('ACCOUNT_RETRIEVE_CURRENT'); } catch (e) { err2 = e; }
    expect(err2.message + JSON.stringify(err2)).not.toContain(KEY_TEXT);
    // the whole acquire path with a leaking transport: outcome and audit stream stay clean
    const events: ReadAuditEvent[] = [];
    const adapter = new StripeReadOnlyEvidenceAdapter({ transport: t, authorization: AUTH, clock: () => NOW, audit: e => events.push(e) });
    const out = await adapter.acquire(scope);
    expect(out).toEqual({ ok: false, kind: 'PROVIDER_FAILURE', failureClass: 'PROVIDER_REJECTED' });
    expect(JSON.stringify([out, events])).not.toMatch(/rk_test|SECRET-PAYLOAD|example\.com|Bearer/);
  });
});

describe('real test-mode evidence acquisition (mocked transport)', () => {
  it('1. authorized test-mode account retrieval succeeds and is bound to the approved account', async () => {
    const { adapter, transport, events } = adapterFor([account, fixtureInvoice()]);
    const out = await adapter.acquire(scope);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(transport.calls[0]).toEqual({ method: 'ACCOUNT_RETRIEVE_CURRENT', invoiceId: null });
    expect(out.evidence.accountId).toMatchObject({ state: 'VERIFIED', value: ACCT, origin: 'STRIPE_TEST_READ' });
    expect(out.evidence.mode).toMatchObject({ state: 'VERIFIED', value: 'test' });
    // DEV-08: the four unauthorized reads are now ASKED FOR and denied at runtime inside the provider, so the denial is part of the audit stream (and no transport call is made for them)
    expect(events.map(e => `${e.event}:${e.methodId}`)).toEqual(['stripe_read.attempt:ACCOUNT_RETRIEVE_CURRENT', 'stripe_read.success:ACCOUNT_RETRIEVE_CURRENT', 'stripe_read.attempt:INVOICE_RETRIEVE', 'stripe_read.attempt:INVOICE_RETRIEVE', 'stripe_read.success:INVOICE_RETRIEVE',
      'stripe_read.denied:INVOICE_LINES_LIST', 'stripe_read.denied:PAYMENT_RETRIEVE', 'stripe_read.denied:REFUNDS_LIST', 'stripe_read.denied:DISPUTES_LIST']);
    expect(events.every(e => e.origin === 'STRIPE_TEST_READ')).toBe(true);
    expect(transport.calls.map(c => c.method)).toEqual(['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE', 'INVOICE_RETRIEVE']);
  });

  it('2. authorized test-mode invoice retrieval succeeds; fields are verified with their source and mapping, and the observation time is the server clock', async () => {
    const { adapter } = adapterFor([account, fixtureInvoice({ id: 'in_1' })]);
    const out = await adapter.acquire(scope);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const e = out.evidence; const i = e.invoice;
    expect(e.origin).toBe('STRIPE_TEST_READ'); expect(e.observedAtMs).toBe(NOW);
    expect(i.status).toMatchObject({ state: 'VERIFIED', value: 'paid', origin: 'STRIPE_TEST_READ', mapping: 'PROVIDER_SCHEMA' });
    expect(i.currency.value).toBe('usd'); expect(i.customerRef.value).toBe('cus_1'); expect(i.subscriptionRef.value).toBe('sub_1');
    expect(i.createdAtMs.value).toBe(1_700_000_000_000); expect(i.paidAtMs.value).toBe(1_700_000_100_000); expect(i.voidedAtMs.state).toBe('CONFIRMED_ABSENT');
    expect(i.amounts.value).toEqual({ dueMinor: 2700, paidMinor: 2700, remainingMinor: 0, totalMinor: 2700 });
    expect(i.lines.value).toEqual({ items: [{ lineRef: 'il_base', amountMinor: 3000, currency: 'usd' }, { lineRef: 'il_ben', amountMinor: -300, currency: 'usd' }], pageComplete: true });
    expect(e.stable.state).toBe('VERIFIED');
    expect(Object.isFrozen(e)).toBe(true);
    expect(sealedOriginOf(e)).toBe('STRIPE_TEST_READ');
  });

  it('6. wrong-account evidence is rejected before any invoice is requested', async () => {
    const { adapter, transport } = adapterFor([{ object: 'account', id: 'acct_SomeOtherAccount' }, fixtureInvoice()]);
    expect(await adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'ACCOUNT_MISMATCH' });
    expect(transport.calls.map(c => c.method)).toEqual(['ACCOUNT_RETRIEVE_CURRENT']);
    for (const bad of [null, {}, { object: 'customer', id: ACCT }, { object: 'account' }, { object: 'account', id: 5 }, 'acct']) {
      expect(await adapterFor([bad, fixtureInvoice()]).adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'ACCOUNT_RESPONSE_INVALID' });
    }
  });

  it('8. invoice identity mismatches are rejected: another invoice id, another object type, another customer or subscription', async () => {
    expect(await adapterFor([account, fixtureInvoice({ id: 'in_other' })]).adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'INVOICE_IDENTITY_MISMATCH' });
    for (const bad of [{ ...fixtureInvoice(), object: 'charge' }, null, 'in_1', [], { id: 'in_1' }]) expect(await adapterFor([account, bad]).adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'OBJECT_MISMATCH' });
    expect(await adapterFor([account, fixtureInvoice({ customer: 'cus_other' })]).adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'BINDING_MISMATCH' });
    expect(await adapterFor([account, fixtureInvoice({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_other' } } })]).adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'BINDING_MISMATCH' });
    expect(await adapterFor([account, fixtureInvoice()]).adapter.acquire({ ...scope, invoiceId: 'cus_1' })).toEqual({ ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' });
  });

  it('9. fields without a source-supported mapping are UNRESOLVED, never guessed', async () => {
    const out = await adapterFor([account, fixtureInvoice()]).adapter.acquire(scope);
    if (!out.ok) throw new Error('expected evidence');
    const e = out.evidence;
    for (const f of [e.lineAttribution, e.billingInterval, e.benefitItem, e.cancellation, e.settlingPayment, e.refunds, e.disputes]) {
      expect(f).toMatchObject({ state: 'UNRESOLVED', value: null, origin: 'NONE', mapping: 'NONE' });
      expect(f.reason).toMatch(/Q1\/Q2/);
    }
    // a malformed or incomplete provider response leaves exactly that field unresolved
    const noTransitions = (await adapterFor([account, fixtureInvoice({ status_transitions: undefined })]).adapter.acquire(scope)) as any;
    expect(noTransitions.evidence.invoice.paidAtMs).toMatchObject({ state: 'UNRESOLVED', reason: 'STATUS_TRANSITIONS_MISSING' });
    const partialLines = (await adapterFor([account, fixtureInvoice({ lines: { has_more: true, data: [] } })]).adapter.acquire(scope)) as any;
    expect(partialLines.evidence.invoice.lines).toMatchObject({ state: 'UNRESOLVED', reason: 'LINES_PAGE_INCOMPLETE' });
    const noLines = (await adapterFor([account, fixtureInvoice({ lines: undefined })]).adapter.acquire(scope)) as any;
    expect(noLines.evidence.invoice.lines.state).toBe('UNRESOLVED');
    const noStatus = (await adapterFor([account, fixtureInvoice({ status: 'something_new' })]).adapter.acquire(scope)) as any;
    expect(noStatus.evidence.invoice.status.state).toBe('UNRESOLVED');
    const noParent = (await adapterFor([account, fixtureInvoice({ parent: null })]).adapter.acquire(scope)) as any;
    expect(noParent.evidence.invoice.subscriptionRef).toMatchObject({ state: 'UNRESOLVED', reason: 'SUBSCRIPTION_PARENT_MISSING' });
  });

  it('12. malformed or future timestamps are rejected as unresolved or contradictory and the evidence is never complete', async () => {
    for (const created of [1.5, '1700000000', -1, Number.MAX_SAFE_INTEGER, null, undefined, NaN]) {
      const out = (await adapterFor([account, fixtureInvoice({ created })]).adapter.acquire(scope)) as any;
      expect(['UNRESOLVED', 'CONTRADICTORY']).toContain(out.evidence.invoice.createdAtMs.state);
      expect(out.evidence.invoice.createdAtMs.value).toBeNull();
      expect(out.evidence.complete).toBe(false);
    }
    for (const paid_at of [1.5, 'x', -5, {}, [], 1e18]) {
      const out = (await adapterFor([account, fixtureInvoice({ status_transitions: { paid_at, voided_at: null } })]).adapter.acquire(scope)) as any;
      expect(['UNRESOLVED', 'CONTRADICTORY']).toContain(out.evidence.invoice.paidAtMs.state);
      expect(out.evidence.complete).toBe(false);
    }
    const future = (await adapterFor([account, fixtureInvoice({ created: Math.floor(NOW / 1000) + 10_000 })]).adapter.acquire(scope)) as any;
    expect(future.evidence.invoice.createdAtMs).toMatchObject({ state: 'CONTRADICTORY', reason: 'CREATED_IN_FUTURE' });
    expect(future.evidence.contradictions).toContain('CREATED_IN_FUTURE');
    // the mock path uses the same normalizer, so the classifiers never see a malformed timestamp as a valid one
    const r = await classify({ invoiceBefore: fixtureInvoice({ created: 1.5 }) });
    expect(r.settlement.verdict).not.toBe('ELIGIBLE'); expect(r.settlementEvidence).toBeNull();
  });

  it('13. currency inconsistencies are rejected: malformed currency, a line in another currency, an expected-currency mismatch', async () => {
    const upper = (await adapterFor([account, fixtureInvoice({ currency: 'USD' })]).adapter.acquire(scope)) as any;
    expect(upper.evidence.invoice.currency.state).toBe('UNRESOLVED');
    const mixed = (await adapterFor([account, fixtureInvoice({ lines: { has_more: false, data: [{ id: 'il_base', amount: 3000, currency: 'usd' }, { id: 'il_ben', amount: -300, currency: 'eur' }] } })]).adapter.acquire(scope)) as any;
    expect(mixed.evidence.invoice.lines).toMatchObject({ state: 'CONTRADICTORY', reason: 'LINE_CURRENCY_MISMATCH' });
    expect(mixed.evidence.complete).toBe(false);
    const wrongExpected = classifyBundle(ctx({ expected: { ...ctx().expected, currency: 'eur', frozenAllocation: { ...ctx().expected.frozenAllocation, currency: 'eur' } } }), await mock(), binding, null);
    expect(wrongExpected.settlement.verdict).toBe('UNRESOLVED'); expect(wrongExpected.settlement.reasonCodes).toContain('CURRENCY_MISMATCH');
  });

  it('14. contradictory payment evidence is rejected: paid with money remaining, paid without a paid time, a paid time on an unpaid invoice, paid and voided, an unordered timeline', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['AMOUNTS_INCONSISTENT', { amount_remaining: 100 }],
      ['PAID_WITHOUT_PAID_AT', { status_transitions: { paid_at: null, voided_at: null } }],
      ['PAID_AT_WITHOUT_PAID_STATUS', { status: 'open', amount_paid: 0, amount_remaining: 2700 }],
      ['PAID_AND_VOIDED', { status_transitions: { paid_at: 1_700_000_100, voided_at: 1_700_000_200 } }],
      ['TRANSITION_BEFORE_CREATION', { status_transitions: { paid_at: 1_699_999_000, voided_at: null } }],
      ['LINES_TOTAL_MISMATCH', { total: 2600 }],
      ['DUPLICATE_LINE', { lines: { has_more: false, data: [{ id: 'il_base', amount: 3000, currency: 'usd' }, { id: 'il_base', amount: -300, currency: 'usd' }] } }],
    ];
    for (const [reason, over] of cases) {
      const out = (await adapterFor([account, fixtureInvoice(over)]).adapter.acquire(scope)) as any;
      expect(out.evidence.contradictions, reason).toContain(reason);
      expect(out.evidence.complete, reason).toBe(false);
      const m = await classify({ invoiceBefore: fixtureInvoice(over) });
      expect(m.settlement.verdict, reason).not.toBe('ELIGIBLE');
    }
  });

  it('17. incomplete evidence is not treated as complete, and no caller input can assert completeness', async () => {
    const real = (await adapterFor([account, fixtureInvoice()]).adapter.acquire(scope)) as any;
    expect(real.evidence.complete).toBe(false);
    expect(Object.isFrozen(real.evidence)).toBe(true);
    expect(() => { 'use strict'; (real.evidence as any).complete = true; }).toThrow();
    const lines = (await adapterFor([account, fixtureInvoice({ lines: { has_more: true, data: [] } })]).adapter.acquire(scope)) as any;
    expect(lines.evidence.complete).toBe(false);
    // the mock path computes completeness too: one unresolved category makes it incomplete; a fully specified fixture is complete
    expect((await mock()).complete).toBe(true);
    for (const over of [{ settlingPayment: 'unresolved' }, { refunds: 'unresolved' }, { disputes: 'unresolved' }, { lineAttribution: 'unresolved' }, { billingInterval: 'unresolved' }, { benefitItem: 'unresolved' }, { cancellation: 'unresolved' }] as const)
      expect((await mock(over as any)).complete, JSON.stringify(over)).toBe(false);
    // unstable bracketing reads
    const unstable = (await adapterFor([account, fixtureInvoice(), fixtureInvoice({ amount_due: 2800, amount_paid: 2800 })]).adapter.acquire(scope)) as any;
    expect(unstable.evidence.stable.state).toBe('CONTRADICTORY'); expect(unstable.evidence.complete).toBe(false);
    expect(unstable.evidence.contradictions).toContain('EVIDENCE_UNSTABLE');
  });

  it('18. duplicate retrieval is safe and idempotent: only GETs, no state, identical digest for identical provider state', async () => {
    const a1 = adapterFor([account, fixtureInvoice()], AUTH, NOW);
    const a2 = adapterFor([account, fixtureInvoice()], AUTH, NOW + 5_000);
    const [x, y, z] = [await a1.adapter.acquire(scope), await a1.adapter.acquire(scope), await a2.adapter.acquire(scope)] as any[];
    expect(x.evidence.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(y.evidence.digest).toBe(x.evidence.digest);
    expect(z.evidence.digest).toBe(x.evidence.digest); // observed at a different instant, same provider state
    expect(z.evidence.observedAtMs).not.toBe(x.evidence.observedAtMs);
    expect(a1.transport.calls.every(c => c.method === 'ACCOUNT_RETRIEVE_CURRENT' || c.method === 'INVOICE_RETRIEVE')).toBe(true);
    expect(a1.transport.calls).toHaveLength(6);
    const changed = (await adapterFor([account, fixtureInvoice({ status: 'open', amount_paid: 0, amount_remaining: 2700, status_transitions: { paid_at: null, voided_at: null } })]).adapter.acquire(scope)) as any;
    expect(changed.evidence.digest).not.toBe(x.evidence.digest);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('D1 and D3 classifier integration (mock evidence only)', () => {
  it('a fully verified synthetic fixture is ELIGIBLE and no classification grants financial authority', async () => {
    const r = await classify();
    expect(r.origin).toBe('MOCK_FIXTURE');
    expect(r.settlement).toMatchObject({ verdict: 'ELIGIBLE', reasonCodes: ['ALL_CONDITIONS_VERIFIED'], grantsFinancialAuthority: false, reservationHeld: true });
    expect(r.refundDispute).toMatchObject({ classification: 'NO_REFUND', grantsFinancialAuthority: false });
    expect(r.settlementEvidence?.provenance.evidenceKind).toBe('MOCK_SYNTHETIC');
  });

  it('10. missing required evidence can never produce ELIGIBLE', async () => {
    for (const over of [{ settlingPayment: 'unresolved' }, { settlingPayment: 'absent' }, { refunds: 'unresolved' }, { disputes: 'unresolved' }, { lineAttribution: 'unresolved' }, { benefitItem: 'unresolved' }, { benefitItem: 'absent' },
      { cancellation: 'unresolved' }, { billingInterval: 'unresolved' }] as const) {
      const r = await classify(over as any);
      expect(r.settlement.verdict, JSON.stringify(over)).not.toBe('ELIGIBLE');
    }
    // a real (authentic-origin) read can never be ELIGIBLE either: its categories are unresolved and its kind is not accepted by the classifier
    const real = (await adapterFor([account, fixtureInvoice()]).adapter.acquire(scope)) as any;
    const r = classifyBundle(ctx(), real.evidence, binding, rdCtx());
    expect(r.settlement.verdict).toBe('UNRESOLVED'); expect(r.settlement.reasonCodes).toEqual(['EVIDENCE_KIND_UNSUPPORTED']);
  });

  it('11. missing refund history can never produce NO_REFUND, and an empty "verified" list is not an absence', async () => {
    for (const refunds of ['unresolved'] as const) {
      const r = await classify({ refunds });
      expect(refundExtent(await mock({ refunds }), 2700)).toBe('unknown');
      expect(r.refundDispute?.classification).not.toBe('NO_REFUND');
      expect(r.settlement.verdict).toBe('UNRESOLVED'); expect(r.settlement.reasonCodes).toContain('INCOMPLETE_EVIDENCE');
    }
    expect(refundExtent(await mock({ refunds: [] }), 2700)).toBe('unknown');
    expect((await classify({ refunds: [] })).settlement.verdict).not.toBe('ELIGIBLE');
    expect(refundExtent(await mock({ refunds: 'absent' }), 2700)).toBe('none');
  });

  it('15. an open dispute cannot authorize consumption', async () => {
    const dispute = { id: 'dp_1', businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', amountMinor: 2700, outcome: 'open' as const, closedAtMs: null, overlapsRefundIds: [] };
    const r = await classify({ disputes: [dispute] });
    expect(disputeState(await mock({ disputes: [dispute] }))).toBe('open');
    expect(r.settlement.verdict).toBe('UNRESOLVED'); expect(r.settlement.reasonCodes).toContain('DISPUTE_OPEN');
    expect(r.refundDispute?.classification).toBe('DISPUTE_OPEN');
  });

  it('16. multiple disputes remain fail-closed under the existing policy', async () => {
    const d = (id: string, outcome: 'lost' | 'won') => ({ id, businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', amountMinor: 1000, outcome, closedAtMs: NOW - 10, overlapsRefundIds: [] as string[] });
    const r = await classify({ disputes: [d('dp_1', 'lost'), d('dp_2', 'won')] });
    expect(disputeState(await mock({ disputes: [d('dp_1', 'lost'), d('dp_2', 'won')] }))).toBe('unknown');
    expect(r.refundDispute?.classification).toBe('CONTRADICTORY_EVIDENCE'); expect(r.refundDispute?.reasonCodes).toContain('MULTIPLE_DISPUTES_UNDEFINED');
    expect(r.settlement.verdict).toBe('UNRESOLVED');
    expect((await classify({ disputes: [d('dp_1', 'won'), d('dp_2', 'won')] })).settlement.verdict).not.toBe('ELIGIBLE');
  });

  it('refund outcomes keep their existing meaning: a full refund is INELIGIBLE, a pending or partial one is not eligible', async () => {
    const refund = (finality: 'succeeded' | 'pending', amountMinor: number) => ({ id: 're_1', businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', amountMinor, finality, finalizedAtMs: finality === 'succeeded' ? NOW - 10 : null });
    expect((await classify({ refunds: [refund('succeeded', 2700)] })).settlement).toMatchObject({ verdict: 'INELIGIBLE', reasonCodes: ['REFUNDED'] });
    expect((await classify({ refunds: [refund('pending', 2700)] })).settlement.verdict).toBe('UNRESOLVED');
    expect((await classify({ refunds: [refund('succeeded', 100)] })).settlement.verdict).toBe('UNRESOLVED');
  });

  it('an unpaid invoice, a stale observation and a wrong account/mode/tenant never classify as ELIGIBLE', async () => {
    expect((await classify({ invoiceBefore: fixtureInvoice({ status: 'open', amount_paid: 0, amount_remaining: 2700, status_transitions: { paid_at: null, voided_at: null } }), settlingPayment: 'unresolved' })).settlement.verdict).toBe('UNRESOLVED');
    const stale = classifyBundle({ ...ctx(), nowMs: NOW + 10_000_000 }, await mock(), binding, rdCtx());
    expect(stale.settlement.reasonCodes).toContain('STALE_EVIDENCE');
    const wrongAccount = classifyBundle(ctx({ expected: { ...ctx().expected, providerAccountId: 'acct_Other' } }), await mock(), binding, null);
    expect(wrongAccount.settlement.reasonCodes).toContain('SCOPE_MISMATCH');
    const wrongTenant = classifyBundle(ctx(), await mock(), { ...binding, businessId: 'biz-2' }, null);
    expect(wrongTenant.settlement.reasonCodes).toContain('TENANT_MISMATCH');
    const wrongFreeze = classifyBundle(ctx({ expected: { ...ctx().expected, frozenAllocation: { ...ctx().expected.frozenAllocation, allocationDigest: 'zz' } } }), await mock(), binding, null);
    expect(wrongFreeze.settlement.reasonCodes).toContain('FROZEN_ALLOCATION_MISMATCH');
    const noFreshness = classifyBundle({ ...ctx(), policy: { ...ctx().policy, freshnessWindowMs: null } }, await mock(), binding, null);
    expect(noFreshness.settlement.reasonCodes).toContain('FRESHNESS_POLICY_UNAVAILABLE');
  });

  it('21. mock evidence cannot impersonate authentic Stripe evidence, and authentic evidence cannot be built from data', async () => {
    const m = await mock();
    const real = ((await adapterFor([account, fixtureInvoice()]).adapter.acquire(scope)) as any).evidence;
    expect(sealedOriginOf(m)).toBe('MOCK_FIXTURE'); expect(sealedOriginOf(real)).toBe('STRIPE_TEST_READ');
    // a clone, a serialized round trip, a hand-built object and an object whose origin was edited are all unsealed
    for (const forged of [JSON.parse(JSON.stringify(m)), { ...m }, { ...m, origin: null }, { ...m, origin: undefined }, { ...real, origin: null }, { ...m, origin: 'STRIPE_TEST_READ' }, JSON.parse(JSON.stringify(real)), { ...real, origin: 'MOCK_FIXTURE' }, structuredClone(m), Object.create(m)]) {
      expect(sealedOriginOf(forged)).toBeNull();
      const r = classifyBundle(ctx(), forged as any, binding, rdCtx());
      expect(r.origin).toBe('UNSEALED'); expect(r.settlementEvidence).toBeNull();
      expect(r.settlement.verdict).toBe('UNRESOLVED'); expect(r.settlement.reasonCodes).toEqual(['EVIDENCE_KIND_UNSUPPORTED']);
    }
    // a sealed mock bundle is labelled mock all the way down; a real one is never converted into classifier evidence
    expect(classifyBundle(ctx(), m, binding, null).settlementEvidence?.provenance.evidenceKind).toBe('MOCK_SYNTHETIC');
    expect(classifyBundle(ctx(), real, binding, null)).toMatchObject({ origin: 'STRIPE_TEST_READ', settlementEvidence: null });
    expect(real.origin).toBe('STRIPE_TEST_READ'); expect(m.origin).toBe('MOCK_FIXTURE');
    // the classifiers refuse any authority assertion in the context or evidence
    expect(classifyBundle({ ...ctx(), eligible: true } as any, m, binding, null).settlement.reasonCodes).toEqual(['CALLER_AUTHORITY_ASSERTED']);
  });
});

describe('trusted evidence authority (private verifier boundary)', () => {
  const nonce = (c: string) => c.repeat(24);
  const invReq = (n: string, op: InvocationRequest['operation'] = 'GET /v1/invoices/{id}', over: Partial<InvocationRequest> = {}): InvocationRequest => ({ audience: 'echo-grid-s08-stripe-test-verifier', operation: op, inventoryRevision: 'rev-synthetic-1',
    nonce: nonce(n), issuedAt: NOW - 1_000, expiresAt: NOW + 60_000, ...(op === 'GET /v1/invoices/{id}' ? { invoiceScope: { ...scope } } : {}), ...over });
  const policy: InvocationPolicy = { approved: true, revoked: false, callerPrincipal: 'caller-1', audience: 'echo-grid-s08-stripe-test-verifier', credentialVersion: 'v1', inventoryRevision: 'rev-synthetic-1',
    methods: ['GET /v1/account', 'GET /v1/invoices/{id}'], expiresAt: NOW + 3_600_000, invoiceScope: { ...scope } };
  const harness = (responses: unknown[], over: { policy?: InvocationPolicy | null; resolve?: (b: string, i: string) => Promise<TrustedInvoiceScope | null>; claim?: (k: string) => Promise<boolean> } = {}) => {
    const a = adapterFor(responses);
    const seen = new Set<string>();
    const service = new TrustedStripeEvidenceService<string>({
      adapter: a.adapter, policy: over.policy === undefined ? policy : over.policy,
      invocation: {
        authenticate: async (proof, canonical) => (proof === 'valid' ? { principal: 'caller-1', audience: 'echo-grid-s08-stripe-test-verifier', credentialVersion: 'v1', authenticatedRequest: canonical } : null),
        claimOnce: over.claim ?? (async k => { if (seen.has(k)) return false; seen.add(k); return true; }),
      },
      resolveScope: over.resolve ?? (async (b, i) => (b === scope.businessId && i === scope.invoiceId ? { ...scope } : null)), clock: () => NOW,
    });
    return { ...a, service };
  };
  const pair = (n = 'a', proof = 'valid') => ({ account: { request: invReq(n + 'x', 'GET /v1/account'), proof }, invoice: { request: invReq(n + 'y'), proof } });

  it('with approved, authenticated, in-scope requests it returns sealed evidence bound to the trusted scope', async () => {
    const h = harness([account, fixtureInvoice()]);
    const r = await h.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('a'));
    expect(r.status).toBe('OK');
    if (r.status === 'OK') { expect(sealedOriginOf(r.evidence)).toBe('STRIPE_TEST_READ'); expect(r.evidence.requested).toEqual({ businessId: 'biz-1', invoiceId: 'in_1', expectedAccountId: ACCT }); }
    expect(canonicalPrivateInvocation(pair('a').invoice.request)).toContain('S08-PV05-v1');
  });

  it('7. wrong-tenant requests are rejected before any provider call: an invoice that is not the tenant\'s, a mismatching resolved scope, a mismatching invocation scope', async () => {
    const h = harness([account, fixtureInvoice()]);
    expect(await h.service.readInvoiceEvidence({ businessId: 'biz-2', invoiceId: 'in_1' }, pair('b'))).toEqual({ status: 'DENIED', reason: 'TENANT_MISMATCH' });
    const swapped = harness([account, fixtureInvoice()], { resolve: async () => ({ ...scope, businessId: 'biz-2' }) });
    expect(await swapped.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('c'))).toEqual({ status: 'DENIED', reason: 'TENANT_MISMATCH' });
    const other = pair('d'); (other.invoice.request as any) = invReq('dy', 'GET /v1/invoices/{id}', { invoiceScope: { ...scope, customerId: 'cus_other' } });
    expect(await h.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, other)).toEqual({ status: 'DENIED', reason: 'SCOPE_MISMATCH' });
    // the invocation request and the approved policy agree with each other but NOT with the persisted binding: the persisted (tenant-checked) scope wins
    const drift = harness([account, fixtureInvoice()], { resolve: async () => ({ ...scope, customerId: 'cus_persisted_other' }) });
    expect(await drift.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('f2'))).toEqual({ status: 'DENIED', reason: 'SCOPE_MISMATCH' });
    expect(drift.transport.calls).toEqual([]);
    // request and policy name ANOTHER invoice of the same tenant than the one the caller asked about: the resolved (requested) invoice wins
    const otherInvoice = { ...scope, invoiceId: 'in_2' };
    const elsewhere = harness([account, fixtureInvoice()], { policy: { ...policy, invoiceScope: otherInvoice } });
    const pairOther = pair('f3'); (pairOther.invoice.request as any) = invReq('f3y', 'GET /v1/invoices/{id}', { invoiceScope: otherInvoice });
    expect(await elsewhere.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pairOther)).toEqual({ status: 'DENIED', reason: 'SCOPE_MISMATCH' });
    expect(elsewhere.transport.calls).toEqual([]);
    const broken = harness([account, fixtureInvoice()], { resolve: async () => { throw new Error('db down'); } });
    expect(await broken.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('e'))).toEqual({ status: 'DENIED', reason: 'DEPENDENCY_UNAVAILABLE' });
    for (const x of [h, swapped, broken]) expect(x.transport.calls).toEqual([]);
  });

  it('refuses callers that assert anything, are unauthenticated, are replayed or are out of policy, all before any provider call', async () => {
    const h = harness([account, fixtureInvoice()]);
    for (const extra of [{ complete: true }, { verdict: 'ELIGIBLE' }, { eligible: true }, { accountId: ACCT }, { mode: 'test' }, { verified: true }, { consumptionAuthorized: true }, { origin: 'STRIPE_TEST_READ' }]) {
      expect(await h.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1', ...extra } as any, pair('f'))).toEqual({ status: 'DENIED', reason: 'CALLER_ASSERTION_REFUSED' });
    }
    for (const bad of [null, undefined, {}, { businessId: 1, invoiceId: 'in_1' }, 'x']) expect(await h.service.readInvoiceEvidence(bad as any, pair('g'))).toEqual({ status: 'DENIED', reason: 'INVALID_REQUEST' });
    expect(await h.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('h', 'forged-proof'))).toEqual({ status: 'DENIED', reason: 'INVOCATION_AUTHENTICATION_FAILED' });
    expect(await harness([account, fixtureInvoice()], { policy: null }).service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('i'))).toEqual({ status: 'DENIED', reason: 'INVOCATION_APPROVAL_EXPIRED' });
    const replay = harness([account, fixtureInvoice()]);
    expect((await replay.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('j'))).status).toBe('OK');
    expect(await replay.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('j'))).toEqual({ status: 'DENIED', reason: 'INVOCATION_REPLAY_REJECTED' });
    const offline = harness([account, fixtureInvoice()], { claim: async () => { throw new Error('store down'); } });
    expect(await offline.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('k'))).toEqual({ status: 'DENIED', reason: 'INVOCATION_DEPENDENCY_UNAVAILABLE' });
    const wrongOp = pair('l'); (wrongOp.invoice.request as any) = invReq('ly', 'GET /v1/account');
    expect(await h.service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, wrongOp)).toEqual({ status: 'DENIED', reason: 'INVALID_REQUEST' });
    expect(h.transport.calls).toEqual([]);
  });

  it('provider failures and denials from the adapter pass through as safe results', async () => {
    expect(await harness([{ throws: 'TIMEOUT' }]).service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('m'))).toEqual({ status: 'PROVIDER_FAILURE', failureClass: 'TIMEOUT' });
    expect(await harness([{ object: 'account', id: 'acct_Other' }, fixtureInvoice()]).service.readInvoiceEvidence({ businessId: 'biz-1', invoiceId: 'in_1' }, pair('n'))).toEqual({ status: 'DENIED', reason: 'ACCOUNT_MISMATCH' });
  });
});
