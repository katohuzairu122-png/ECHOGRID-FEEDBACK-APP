/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createRealReadProvider, createStripeGetTransport, EvidenceAcquisitionPipeline, evaluateCompleteness, onePage, pagesOf, ScriptedReadTransport, sealedOriginOf, StripeReadOnlyEvidenceAdapter,
  type AcquisitionBinding, type AcquisitionConfig, type ReadAuditEvent, type ReadAuthorization, type ReadProvider,
} from './index';
import {
  ACCT, API, AUTH, baseLines, binding, BENEFIT_ITEM, CONFIG, account, dispute, invocationHarness, invoice, itemParent, line, mockProvider, NOW, pay, refund, SCOPE, subParent,
} from './pipeline-fixtures';
import type { mockFixtures } from './pipeline-fixtures';

/**
 * S08-D1D3-DEV-08 acceptance tests for the acquisition pipeline. Synthetic fixtures, a scripted transport and an injected fake fetch only: no network, no key, no Stripe account.
 * Provider shapes follow the SDK-schema profile and are NOT proven live (Q1/Q2); these tests prove the orchestration and its fail-closed rules, not Stripe's behaviour.
 */
const KEY_TEXT = ['rk', 'test', 'SyntheticKeyMaterial0123456789'].join('_');
const realKey = () => KEY_TEXT;

type Opts = { provider?: ReadProvider; config?: AcquisitionConfig; resolve?: (b: string, i: string) => Promise<AcquisitionBinding | null>; clock?: () => number; withInvocation?: boolean };
function make(o: Opts = {}) {
  const events: ReadAuditEvent[] = [];
  const h = invocationHarness();
  const pipeline = new EvidenceAcquisitionPipeline<string>({
    provider: o.provider ?? mockProvider(), config: o.config ?? CONFIG, clock: o.clock ?? (() => NOW), audit: e => events.push(e),
    resolveBinding: o.resolve ?? (async (b, i) => (b === SCOPE.businessId && i === SCOPE.invoiceId ? binding() : null)),
    ...(o.withInvocation ? { invocation: { policy: h.policy, deps: h.deps } } : {}),
  });
  return { pipeline, events, h };
}
const REQ = { businessId: 'biz-1', invoiceId: 'in_1' };
const run = (o: Opts = {}) => make(o).pipeline.run(REQ);
const fixture = (over: Parameters<typeof mockFixtures>[0] = {}) => mockProvider({ ...over });
function realRig(over: { authorization?: ReadAuthorization | null; responses?: unknown[] } = {}) {
  const transport = new ScriptedReadTransport(over.responses ?? [account, invoice()]);
  const events: ReadAuditEvent[] = [];
  const provider = createRealReadProvider({ transport, authorization: over.authorization === undefined ? AUTH : over.authorization, clock: () => NOW, audit: e => events.push(e) });
  const h = invocationHarness();
  const pipeline = new EvidenceAcquisitionPipeline<string>({ provider, config: CONFIG, clock: () => NOW, audit: e => events.push(e), resolveBinding: async () => binding(), invocation: { policy: h.policy, deps: h.deps } });
  return { transport, events, pipeline, h, provider };
}

describe('1-3. acquisition, mock reads and unapproved real reads', () => {
  it('1. a complete synthetic acquisition produces a normalized, versioned, sealed bundle with preserved origin and observation time', async () => {
    const provider = mockProvider();
    const r = await make({ provider }).pipeline.run(REQ);
    expect(r.status).toBe('CLASSIFIED');
    if (r.status !== 'CLASSIFIED') return;
    expect(r.evidence.contractVersion).toBe('S08-STRIPE-EVIDENCE/1');
    expect(r.origin).toBe('MOCK_FIXTURE'); expect(r.evidence.origin).toBe('MOCK_FIXTURE'); expect(sealedOriginOf(r.evidence)).toBe('MOCK_FIXTURE');
    expect(r.evidence.observedAtMs).toBe(NOW);
    expect(r.completeness).toMatchObject({ complete: true, blockers: [], unresolved: [], contradictions: [], schemaDrift: [], freshness: 'FRESH' });
    expect(Object.values(r.completeness.categories).every(s => s === 'VERIFIED' || s === 'CONFIRMED_ABSENT')).toBe(true);
    expect(r.completeness.categories).toMatchObject({ refund_history: 'CONFIRMED_ABSENT', dispute_history: 'CONFIRMED_ABSENT', settling_payment: 'VERIFIED', invoice_lines: 'VERIFIED' });
    expect(provider.calls).toEqual(['account', 'invoice', 'invoice', 'lines', 'payments', 'refunds:payment_intent:pi_1', 'disputes:payment_intent:pi_1']); // the full retrieval sequence, in order
    expect(Object.isFrozen(r.evidence)).toBe(true);
  });

  it('2. authorized account and invoice reads work through the real read provider (scripted transport) and are audited with their origin', async () => {
    const { pipeline, transport, events, h } = realRig();
    const r = await pipeline.run(REQ, h.pair());
    expect(r.status).toBe('REJECTED'); // real evidence is complete only for what is authorized, and is never usable for settlement
    if (r.status !== 'REJECTED') return;
    expect(r.evidence.accountId).toMatchObject({ state: 'VERIFIED', value: ACCT }); expect(r.evidence.mode).toMatchObject({ state: 'VERIFIED', value: 'test' });
    expect(r.evidence.invoice.status).toMatchObject({ state: 'VERIFIED', value: 'paid' });
    expect(transport.calls.map(c => c.method)).toEqual(['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE', 'INVOICE_RETRIEVE']);
    expect(events.filter(e => e.event === 'stripe_read.success').map(e => e.methodId)).toEqual(['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE']);
    expect(events.every(e => e.origin === 'STRIPE_TEST_READ')).toBe(true);
  });

  it('3. unapproved real reads stay blocked: lines pagination, payment, refunds and disputes are denied at runtime with no transport call and an audit record, whatever the authorization lists', async () => {
    const wide: ReadAuthorization = { ...AUTH, methods: ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST', 'ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] as any };
    const { transport, events, provider } = realRig({ authorization: wide });
    const s = { businessId: 'biz-1', invoiceId: 'in_1' };
    for (const call of [provider.listInvoiceLines(s), provider.listInvoicePayments(s), provider.listRefunds(s, { kind: 'payment_intent', ref: 'pi_1' }), provider.listDisputes(s, { kind: 'payment_intent', ref: 'pi_1' })])
      expect(await call).toEqual({ ok: false, kind: 'DENIED', reason: 'METHOD_NOT_AUTHORIZED' });
    expect(transport.calls).toEqual([]);
    expect(events.map(e => `${e.event}:${e.methodId}`)).toEqual(['stripe_read.denied:INVOICE_LINES_LIST', 'stripe_read.denied:PAYMENT_RETRIEVE', 'stripe_read.denied:REFUNDS_LIST', 'stripe_read.denied:DISPUTES_LIST']);
    expect(await provider.supplement(s)).toEqual({ billingInterval: 'unresolved', benefitItem: 'unresolved', cancellation: 'unresolved', idempotency: null });
    // and through the pipeline: the real bundle has those categories UNRESOLVED (never mock-filled), so it is incomplete
    const rig = realRig({ authorization: wide });
    const r = await rig.pipeline.run(REQ, rig.h.pair());
    if (r.status !== 'REJECTED') throw new Error('expected rejection');
    expect(r.completeness.unresolved.map(u => u.category)).toEqual(expect.arrayContaining(['line_attribution', 'settling_payment', 'refund_history', 'dispute_history', 'billing_interval', 'benefit_item', 'cancellation']));
    expect(r.completeness.unresolved.every(u => /Q1\/Q2/.test(u.reason ?? ''))).toBe(true);
    expect(rig.transport.calls.every(c => c.method === 'ACCOUNT_RETRIEVE_CURRENT' || c.method === 'INVOICE_RETRIEVE')).toBe(true);
  });
});

describe('4-6. authorization, mode and credentials', () => {
  it('4. missing read authorization makes zero provider calls', async () => {
    const rig = realRig({ authorization: null });
    expect(await rig.pipeline.run(REQ, rig.h.pair())).toEqual({ status: 'DENIED', reason: 'AUTHORIZATION_MISSING' });
    expect(rig.transport.calls).toEqual([]);
    // a real provider with no invocation contract configured is refused before anything
    const bare = new EvidenceAcquisitionPipeline<string>({ provider: rig.provider, config: CONFIG, clock: () => NOW, audit: () => undefined, resolveBinding: async () => binding() });
    expect(await bare.run(REQ)).toEqual({ status: 'DENIED', reason: 'INVOCATION_REQUIRED' });
    expect(rig.transport.calls).toEqual([]);
  });

  it('5. revoked, expired, unapproved or unlisted read authorization makes zero provider calls', async () => {
    const cases: Array<[Partial<ReadAuthorization>, string]> = [[{ revoked: true }, 'AUTHORIZATION_REVOKED'], [{ expiresAtMs: NOW }, 'AUTHORIZATION_EXPIRED'], [{ approved: false }, 'AUTHORIZATION_INVALID'],
      [{ methods: ['ACCOUNT_RETRIEVE_CURRENT'] }, 'METHOD_NOT_APPROVED'], [{ methods: [] }, 'METHOD_NOT_APPROVED'], [{ accountId: 'nope' }, 'ACCOUNT_NOT_APPROVED']];
    for (const [over, reason] of cases) {
      const rig = realRig({ authorization: { ...AUTH, ...over } });
      expect(await rig.pipeline.run(REQ, rig.h.pair()), reason).toEqual({ status: 'DENIED', reason });
      expect(rig.transport.calls, reason).toEqual([]);
    }
  });

  it('6. live-mode credentials are refused (construction, authorization realm, and a live invoice)', async () => {
    for (const k of [['sk', 'live', 'SyntheticLive0123456789'].join('_'), ['rk', 'live', 'SyntheticLive0123456789'].join('_'), 'pk_test_x', '']) expect(() => createStripeGetTransport({ apiKey: k })).toThrow(/KEY_NOT_TEST_MODE/);
    const live = realRig({ authorization: { ...AUTH, realm: 'live' as any } });
    expect(await live.pipeline.run(REQ, live.h.pair())).toEqual({ status: 'DENIED', reason: 'REALM_NOT_TEST' });
    expect(live.transport.calls).toEqual([]);
    for (const livemode of [true, undefined, null, 'false']) {
      const rig = realRig({ responses: [account, invoice({ livemode })] });
      expect(await rig.pipeline.run(REQ, rig.h.pair())).toEqual({ status: 'DENIED', reason: 'REALM_MISMATCH' });
    }
  });
});

describe('7-9. tenant, account and invoice identity', () => {
  it('7. cross-tenant requests are refused before any provider call: unknown invoice, another tenant\'s binding, a throwing resolver', async () => {
    const provider = mockProvider();
    expect(await make({ provider, resolve: async () => null }).pipeline.run({ businessId: 'biz-2', invoiceId: 'in_1' })).toEqual({ status: 'DENIED', reason: 'TENANT_MISMATCH' });
    expect(await make({ provider, resolve: async () => binding({ scope: { ...SCOPE, businessId: 'biz-2' } }) }).pipeline.run(REQ)).toEqual({ status: 'DENIED', reason: 'TENANT_MISMATCH' });
    expect(await make({ provider, resolve: async () => binding({ binding: { businessId: 'biz-2', reservationId: 'res-1', intentRef: 'intent-1' } }) }).pipeline.run(REQ)).toEqual({ status: 'DENIED', reason: 'TENANT_MISMATCH' });
    expect(await make({ provider, resolve: async () => binding({ scope: { ...SCOPE, invoiceId: 'in_2' } }) }).pipeline.run(REQ)).toEqual({ status: 'DENIED', reason: 'TENANT_MISMATCH' });
    expect(await make({ provider, resolve: async () => { throw new Error('db down'); } }).pipeline.run(REQ)).toEqual({ status: 'DENIED', reason: 'DEPENDENCY_UNAVAILABLE' });
    expect(provider.calls).toEqual([]);
  });

  it('8. wrong-account evidence is rejected before any invoice read', async () => {
    const provider = mockProvider({ account: { object: 'account', id: 'acct_SomeOtherAccount' } });
    expect(await make({ provider }).pipeline.run(REQ)).toEqual({ status: 'DENIED', reason: 'ACCOUNT_MISMATCH' });
    expect(provider.calls).toEqual(['account']);
    for (const bad of [null, {}, 'acct', { object: 'customer', id: ACCT }, { object: 'account' }, { object: 'account', id: 5 }])
      expect(await make({ provider: mockProvider({ account: bad }) }).pipeline.run(REQ)).toEqual({ status: 'DENIED', reason: 'ACCOUNT_RESPONSE_INVALID' });
    expect(await make({ resolve: async () => binding({ expectedAccountId: 'acct_Expected2' }) }).pipeline.run(REQ)).toEqual({ status: 'DENIED', reason: 'ACCOUNT_MISMATCH' });
  });

  it('9. wrong invoice identity is rejected: another invoice id, another object type, another customer or subscription', async () => {
    for (const [inv, reason] of [[invoice({ id: 'in_other' }), 'INVOICE_IDENTITY_MISMATCH'], [{ ...invoice(), object: 'charge' }, 'OBJECT_MISMATCH'], [null, 'OBJECT_MISMATCH'], [invoice({ customer: 'cus_other' }), 'BINDING_MISMATCH'],
      [invoice({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_other' } } }), 'BINDING_MISMATCH']] as const)
      expect(await make({ provider: mockProvider({ invoices: [inv] }) }).pipeline.run(REQ), reason).toEqual({ status: 'DENIED', reason });
  });
});

describe('10-17. completeness and classification', () => {
  const rejected = async (over: Parameters<typeof mockFixtures>[0]) => { const r = await run({ provider: fixture(over) }); if (r.status !== 'REJECTED') throw new Error(`expected REJECTED, got ${r.status}`); return r; };
  const classified = async (over: Parameters<typeof mockFixtures>[0]) => { const r = await run({ provider: fixture(over) }); if (r.status !== 'CLASSIFIED') throw new Error(`expected CLASSIFIED, got ${r.status}`); return r; };

  it('10. invoice-line pagination failure blocks completeness (incomplete, broken cursor, truncated sequence, duplicate across pages)', async () => {
    const pages = pagesOf(baseLines(), 1);
    for (const lines of [[pages[0]!], [pages[0]!, { ...pages[1]!, requestedStartingAfter: 'il_x' }], [] as any[], [{ requestedStartingAfter: null, body: { object: 'list', data: [baseLines()[0]], has_more: true } }, { requestedStartingAfter: 'il_base', body: { object: 'list', data: [baseLines()[0]], has_more: false } }]]) {
      const r = await rejected({ lines });
      expect(r.completeness.blockers).toContain('EVIDENCE_INCOMPLETE');
      expect(['UNRESOLVED', 'CONTRADICTORY']).toContain(r.completeness.categories.invoice_lines);
    }
    expect((await classified({ lines: pagesOf(baseLines(), 1) })).classification.settlement.verdict).toBe('ELIGIBLE'); // a provably complete multi-page list is accepted
  });

  it('11. a missing settling payment blocks eligibility: nothing is classified or recordable', async () => {
    for (const payments of [onePage([]), onePage([pay({ status: 'open', amount_paid: null, status_transitions: { paid_at: null, canceled_at: null } })]), [] as any[]]) {
      const r = await rejected({ payments });
      expect(r.completeness.categories.settling_payment).toBe('UNRESOLVED');
      expect(r.completeness.unresolved.find(u => u.category === 'settling_payment')?.reason).toMatch(/SETTLEMENT_CONFIRMATION_MISSING|NO_PAGES/);
      expect('recordableEvidence' in r).toBe(false);
    }
  });

  it('12. multiple payment candidates block eligibility (two settling payments, one payment named twice, a payment of another invoice)', async () => {
    const second = (over: Record<string, unknown>) => pay({ id: 'inpay_2', ...over });
    expect((await rejected({ payments: onePage([pay(), second({ payment: { type: 'payment_intent', payment_intent: 'pi_2' } })]) })).completeness.unresolved.find(u => u.category === 'settling_payment')?.reason).toBe('MULTIPLE_SETTLING_PAYMENTS');
    expect((await rejected({ payments: onePage([pay(), second({})]) })).completeness.contradictions).toContain('DUPLICATE_PAYMENT_REFERENCE');
    expect((await rejected({ payments: onePage([pay({ invoice: 'in_other' })]) })).completeness.contradictions).toContain('PAYMENT_FOR_OTHER_INVOICE');
  });

  it('13. refund evidence that belongs to another payment is rejected', async () => {
    const r = await rejected({ refunds: onePage([refund({ payment_intent: 'pi_other' })]) });
    expect(r.completeness.contradictions).toContain('REFUND_FOR_OTHER_PAYMENT'); expect(r.completeness.categories.refund_history).toBe('CONTRADICTORY');
    expect((await rejected({ refunds: onePage([refund({ payment_intent: null })]) })).completeness.categories.refund_history).toBe('UNRESOLVED'); // unattributable is not "ours"
  });

  it('14. dispute evidence that belongs to another payment is rejected', async () => {
    const r = await rejected({ disputes: onePage([dispute({ payment_intent: 'pi_other' })]) });
    expect(r.completeness.contradictions).toContain('DISPUTE_FOR_OTHER_PAYMENT'); expect(r.completeness.categories.dispute_history).toBe('CONTRADICTORY');
  });

  it('15. an open dispute blocks consumption authorization: the evidence is classified, the verdict is not eligible, and the D3 class is DISPUTE_OPEN', async () => {
    for (const status of ['needs_response', 'under_review']) {
      const r = await classified({ disputes: onePage([dispute({ status })]) });
      expect(r.classification.settlement.verdict).toBe('UNRESOLVED'); expect(r.classification.settlement.reasonCodes).toContain('DISPUTE_OPEN');
      expect(r.classification.refundDispute?.classification).toBe('DISPUTE_OPEN');
      expect(r.recordableEvidence?.events.dispute).toBe('open');
    }
    expect((await classified({ disputes: onePage([dispute({ status: 'lost' })]) })).classification.settlement).toMatchObject({ verdict: 'INELIGIBLE', reasonCodes: ['PAYMENT_DISPUTE_LOST'] });
  });

  it('16. a partial refund stays unresolved (and a full refund is ineligible); failed or canceled refunds are not "no refund"', async () => {
    const partial = await classified({ refunds: onePage([refund({ amount: 500 })]) });
    expect(partial.classification.settlement).toMatchObject({ verdict: 'UNRESOLVED', reasonCodes: expect.arrayContaining(['REFUND_PARTIAL']) });
    expect(partial.classification.refundDispute?.classification).toBe('PARTIAL_REFUND_VERIFIED');
    expect((await classified({ refunds: onePage([refund({ amount: 2700 })]) })).classification.settlement).toMatchObject({ verdict: 'INELIGIBLE', reasonCodes: ['REFUNDED'] });
    for (const status of ['failed', 'canceled']) expect((await classified({ refunds: onePage([refund({ status })]) })).classification.settlement.verdict).not.toBe('ELIGIBLE');
  });

  it('17. refund/dispute overlap and several disputes remain contradictory and are rejected', async () => {
    const r = await rejected({ refunds: onePage([refund({ amount: 1000 })]), disputes: onePage([dispute({ status: 'lost', amount: 1700 })]) });
    expect(r.completeness.contradictions).toContain('REFUND_DISPUTE_OVERLAP_UNDETERMINED'); expect(r.completeness.blockers).toContain('EVIDENCE_CONTRADICTORY');
    const many = await rejected({ disputes: onePage([dispute({ id: 'dp_1', status: 'lost', amount: 1000 }), dispute({ id: 'dp_2', status: 'won', amount: 1000 })]) });
    expect(many.completeness.contradictions).toContain('MULTIPLE_DISPUTES_ON_PAYMENT');
    expect(many.evidence.disputes.state).toBe('VERIFIED'); // preserved for manual review, not discarded
  });
});

describe('18-21. API version, drift, freshness and malformed input', () => {
  it('18. unsupported API versions fail closed with no provider call', async () => {
    for (const apiVersion of ['2025-01-01.acacia', '', '__proto__', ` ${API}`, '2026-05-27']) {
      const provider = createMockProviderWithVersion(apiVersion);
      expect(await make({ provider }).pipeline.run(REQ), apiVersion).toEqual({ status: 'DENIED', reason: 'UNSUPPORTED_API_VERSION' });
      expect(provider.calls).toEqual([]);
    }
    const rig = (() => { const transport = new ScriptedReadTransport([account, invoice()]); const adapter = new StripeReadOnlyEvidenceAdapter({ transport, authorization: AUTH, clock: () => NOW, audit: () => undefined, apiVersion: '2025-01-01.acacia' }); return { transport, adapter }; })();
    expect(await rig.adapter.acquire(SCOPE)).toEqual({ ok: false, kind: 'DENIED', reason: 'UNSUPPORTED_API_VERSION' }); expect(rig.transport.calls).toEqual([]);
  });

  it('19. schema drift cannot become verified evidence: it is recorded, the category is unresolved, and the bundle is rejected', async () => {
    const cases: Array<[string, Parameters<typeof mockFixtures>[0]]> = [
      ['payment status', { payments: onePage([pay({ status: 'refunded' })]) }], ['refund status', { refunds: onePage([refund({ status: 'reversed' })]) }], ['dispute status', { disputes: onePage([dispute({ status: 'closed' })]) }],
      ['line parent type', { lines: onePage([baseLines()[0], line('il_ben', -300, { type: 'schedule_details' })]) }], ['list shape', { lines: [{ requestedStartingAfter: null, body: { object: 'collection', data: baseLines(), has_more: false } }] }],
      ['refund amount type', { refunds: onePage([refund({ amount: '500' })]) }], ['payment object', { payments: onePage([pay({ object: 'payment' })]) }],
    ];
    for (const [label, over] of cases) {
      const r = await run({ provider: fixture(over) });
      expect(r.status, label).toBe('REJECTED');
      if (r.status !== 'REJECTED') continue;
      expect(r.completeness.blockers.some(b => b === 'EVIDENCE_INCOMPLETE' || b === 'SCHEMA_DRIFT'), label).toBe(true);
      expect(r.completeness.unresolved.length, label).toBeGreaterThan(0);
    }
    const extra = await run({ provider: fixture({ payments: onePage([pay({ brand_new_field: { a: 1 } })]), refunds: onePage([refund({ extra: 1 })]) }) });
    expect(extra.status).toBe('CLASSIFIED'); // unknown ADDITIONAL fields are tolerated
  });

  it('20. stale evidence cannot become eligible, and freshness that cannot be established rejects: boundary at the window, no window, a future observation', async () => {
    let t = NOW; const stepping = () => t++; // each read advances the clock by one
    const stale = await make({ config: { ...CONFIG, freshnessWindowMs: 0 }, clock: stepping }).pipeline.run(REQ);
    expect(stale.status).toBe('REJECTED'); if (stale.status === 'REJECTED') expect(stale.completeness).toMatchObject({ freshness: 'STALE', blockers: ['STALE_EVIDENCE'] });
    const fresh = await make({ config: { ...CONFIG, freshnessWindowMs: 1_000_000 }, clock: (() => { let u = NOW; return () => u++; })() }).pipeline.run(REQ);
    expect(fresh.status).toBe('CLASSIFIED');
    for (const freshnessWindowMs of [null, -1, 1.5, Number.NaN] as any[]) {
      const r = await make({ config: { ...CONFIG, freshnessWindowMs } }).pipeline.run(REQ);
      expect(r.status).toBe('REJECTED'); if (r.status === 'REJECTED') expect(r.completeness.blockers).toContain('FRESHNESS_POLICY_UNAVAILABLE');
    }
    let d = NOW; const decreasing = () => d--;
    const future = await make({ clock: decreasing }).pipeline.run(REQ);
    expect(future.status).toBe('REJECTED'); if (future.status === 'REJECTED') expect(future.completeness.freshness).toBe('FROM_FUTURE');
    // the pure evaluation at the exact boundary: age == window is fresh, window + 1 is stale
    const ok = await make().pipeline.run(REQ); if (ok.status !== 'CLASSIFIED') throw new Error('expected evidence');
    expect(evaluateCompleteness(ok.evidence, NOW + 500, 500, 'MOCK_FIXTURE').freshness).toBe('FRESH');
    expect(evaluateCompleteness(ok.evidence, NOW + 501, 500, 'MOCK_FIXTURE').freshness).toBe('STALE');
    expect(evaluateCompleteness(ok.evidence, NOW - 1, 500, 'MOCK_FIXTURE').freshness).toBe('FROM_FUTURE');
  });

  it('21. malformed runtime inputs are refused without throwing: requests, caller assertions, resolver output, provider bodies', async () => {
    const { pipeline } = make();
    for (const bad of [null, undefined, 5, 'x', [], {}, { businessId: 1, invoiceId: 'in_1' }, { businessId: 'biz-1' }, { invoiceId: 'in_1' }, { businessId: '', invoiceId: '' }]) {
      const r = await pipeline.run(bad as any); expect(r.status).toBe('DENIED');
    }
    for (const extra of [{ complete: true }, { verdict: 'ELIGIBLE' }, { eligible: true }, { consumptionAuthorized: true }, { accountId: ACCT }, { mode: 'test' }, { origin: 'STRIPE_TEST_READ' }, { verified: true }, { freshnessWindowMs: 1e12 }])
      expect(await pipeline.run({ ...REQ, ...extra } as any)).toEqual({ status: 'DENIED', reason: 'CALLER_ASSERTION_REFUSED' });
    for (const resolved of ['x', 5, {}, { scope: null }, { scope: SCOPE }, { scope: SCOPE, classifier: null }, [] ] as any[]) expect((await make({ resolve: async () => resolved }).pipeline.run(REQ)).status).toBe('DENIED');
    for (const body of [null, undefined, 'x', 5, [], {}, { object: 'invoice' }]) expect(['DENIED', 'REJECTED']).toContain((await make({ provider: mockProvider({ invoices: [body] }) }).pipeline.run(REQ)).status);
    for (const lines of ['x', null, 5, [{}], [{ requestedStartingAfter: null, body: null }]] as any[]) expect((await make({ provider: mockProvider({ lines }) }).pipeline.run(REQ)).status).toBe('REJECTED');
  });
});

describe('22-24. failures, leakage and write-path absence', () => {
  it('22. provider timeouts and failures preserve a safe failure result at every step, with no evidence', async () => {
    for (const failureClass of ['TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'PROVIDER_ERROR', 'PROVIDER_REJECTED', 'MALFORMED_RESPONSE', 'RESPONSE_TOO_LARGE'] as const) {
      for (const where of [{ account: { throws: failureClass } }, { invoices: [{ throws: failureClass }] }, { lines: { throws: failureClass } }, { payments: { throws: failureClass } }, { refunds: { throws: failureClass } }, { disputes: { throws: failureClass } }] as any[]) {
        const r = await make({ provider: mockProvider(where) }).pipeline.run(REQ);
        expect(r).toEqual({ status: 'PROVIDER_FAILURE', failureClass });
      }
    }
    const rig = realRig({ responses: [{ throws: 'TIMEOUT' }] }); expect(await rig.pipeline.run(REQ, rig.h.pair())).toEqual({ status: 'PROVIDER_FAILURE', failureClass: 'TIMEOUT' });
  });

  it('23. provider errors never leak credentials or bodies into results or audit events', async () => {
    const SECRET = 'SECRET-PAYLOAD-cus_private@example.com';
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: `Invalid API Key provided: ${realKey()}`, detail: SECRET } }), { status: 401 })) as unknown as typeof fetch;
    const transport = createStripeGetTransport({ apiKey: realKey(), fetchImpl });
    const events: ReadAuditEvent[] = []; const h = invocationHarness();
    const provider = createRealReadProvider({ transport, authorization: AUTH, clock: () => NOW, audit: e => events.push(e) });
    const pipeline = new EvidenceAcquisitionPipeline<string>({ provider, config: CONFIG, clock: () => NOW, audit: e => events.push(e), resolveBinding: async () => binding(), invocation: { policy: h.policy, deps: h.deps } });
    const r = await pipeline.run(REQ, h.pair());
    expect(r).toEqual({ status: 'PROVIDER_FAILURE', failureClass: 'PROVIDER_REJECTED' });
    expect(JSON.stringify([r, events])).not.toMatch(/rk_test|SECRET-PAYLOAD|example\.com|Bearer|Invalid API Key/);
    const throwing = createStripeGetTransport({ apiKey: realKey(), fetchImpl: (async () => { throw new Error(`connect failed using ${realKey()}`); }) as unknown as typeof fetch });
    const p2 = new EvidenceAcquisitionPipeline<string>({ provider: createRealReadProvider({ transport: throwing, authorization: AUTH, clock: () => NOW, audit: () => undefined }), config: CONFIG, clock: () => NOW, audit: () => undefined, resolveBinding: async () => binding(), invocation: { policy: h.policy, deps: h.deps } });
    expect(JSON.stringify(await p2.run(REQ, h.pair()))).not.toContain(realKey());
  });

  it('24. no Stripe write method is reachable: the pipeline, engine, providers and transport expose only reads, and no source file has a write verb or an SDK import', () => {
    expect(Object.getOwnPropertyNames(EvidenceAcquisitionPipeline.prototype).sort()).toEqual(['constructor', 'run']);
    const real = createRealReadProvider({ transport: new ScriptedReadTransport([account, invoice()]), authorization: AUTH, clock: () => NOW, audit: () => undefined });
    expect(Object.keys(real).sort()).toEqual(['apiVersion', 'getAccount', 'getInvoice', 'kind', 'listDisputes', 'listInvoiceLines', 'listInvoicePayments', 'listRefunds', 'preflight', 'supplement']);
    expect(Object.keys(mockProvider()).filter(k => /^(post|put|patch|delete|create|update|write|send|execute|request)/i.test(k))).toEqual([]);
    const dir = resolve(__dirname);
    for (const f of readdirSync(dir).filter(x => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const text = readFileSync(resolve(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(/from 'stripe'|new Stripe\(/.test(text), `${f} imports the SDK client`).toBe(false);
      expect(/\bfetch\s*\(/.test(text) && f !== 'transport.ts', `${f} calls fetch`).toBe(false);
      expect(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(text), `${f} has a write verb`).toBe(false);
      expect(/\.(post|put|patch|del|delete)\(/.test(text), `${f} calls a write method`).toBe(false);
      expect(/refunds\.create|invoices\.(create|update|pay|finalize|void)|paymentIntents\.|subscriptions\.(update|cancel)/.test(text), `${f} names a Stripe write call`).toBe(false);
    }
  });
});

describe('25, 28, 30 and focused negatives', () => {
  it('25. valid synthetic evidence reaches the existing classifier bridge: both classifiers answer, nothing grants authority, only the mock kind is recordable', async () => {
    const r = await run();
    if (r.status !== 'CLASSIFIED') throw new Error('expected CLASSIFIED');
    expect(r.classification.settlement).toMatchObject({ verdict: 'ELIGIBLE', reasonCodes: ['ALL_CONDITIONS_VERIFIED'], grantsFinancialAuthority: false, reservationHeld: true });
    expect(r.classification.refundDispute).toMatchObject({ classification: 'NO_REFUND', grantsFinancialAuthority: false });
    expect(r.recordableEvidence?.provenance.evidenceKind).toBe('MOCK_SYNTHETIC');
    expect(r.recordableEvidence?.settlement).toEqual({ source: 'stripe_payment', paymentRef: 'pi_1' });
    // without a persisted payment reference the D3 classifier is not run (it would only compare the provider with itself); D1 still is
    const noPay = await make({ resolve: async () => binding({ expectedPaymentRef: null }) }).pipeline.run(REQ);
    if (noPay.status !== 'CLASSIFIED') throw new Error('expected CLASSIFIED'); expect(noPay.classification.refundDispute).toBeNull(); expect(noPay.classification.settlement.verdict).toBe('ELIGIBLE');
    // the policy configuration is passed through, never defaulted: no policy instant means UNRESOLVED
    const noPolicy = await make({ config: { ...CONFIG, policyEffectiveFromMs: null } }).pipeline.run(REQ);
    if (noPolicy.status !== 'CLASSIFIED') throw new Error('expected CLASSIFIED'); expect(noPolicy.classification.settlement.reasonCodes).toContain('POLICY_EFFECTIVE_DATE_UNAVAILABLE');
    const wrongVersion = await make({ config: { ...CONFIG, policyVersion: 'PC-BENEFIT/9' } }).pipeline.run(REQ);
    if (wrongVersion.status !== 'CLASSIFIED') throw new Error('expected CLASSIFIED'); expect(wrongVersion.classification.settlement.verdict).toBe('UNRESOLVED');
  });

  it('28. duplicate orchestration changes nothing: identical digests, no state, every run reads the same sequence', async () => {
    const provider = mockProvider();
    const { pipeline } = make({ provider });
    const [a, b, c] = [await pipeline.run(REQ), await pipeline.run(REQ), await pipeline.run(REQ)] as any[];
    expect(a.status).toBe('CLASSIFIED');
    expect(b.evidence.digest).toBe(a.evidence.digest); expect(c.evidence.digest).toBe(a.evidence.digest);
    expect(JSON.stringify(b.classification.settlement)).toBe(JSON.stringify(a.classification.settlement));
    expect(provider.calls.length).toBe(3 * 7);
  });

  it('30. real provider evidence stays disabled for financial authorization: it is rejected, shown to the classifiers as an unaccepted kind, and nothing is recordable', async () => {
    const rig = realRig();
    const r = await rig.pipeline.run(REQ, rig.h.pair());
    if (r.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(r.origin).toBe('STRIPE_TEST_READ'); expect(r.completeness.blockers).toEqual(expect.arrayContaining(['REAL_EVIDENCE_NOT_AUTHORIZED_FOR_SETTLEMENT', 'EVIDENCE_INCOMPLETE']));
    expect(r.classification?.settlement).toMatchObject({ verdict: 'UNRESOLVED', reasonCodes: ['EVIDENCE_KIND_UNSUPPORTED'], grantsFinancialAuthority: false });
    expect(r.classification?.settlementEvidence).toBeNull();
    expect('recordableEvidence' in r).toBe(false);
  });

  it('forged origin: an unsealed or origin-edited bundle is untrusted and blocks, whatever it claims', async () => {
    const ok = await run(); if (ok.status !== 'CLASSIFIED') throw new Error('expected evidence');
    for (const forged of [JSON.parse(JSON.stringify(ok.evidence)), { ...ok.evidence }, { ...ok.evidence, origin: 'STRIPE_TEST_READ' }]) {
      expect(evaluateCompleteness(forged, NOW, 3_600_000, sealedOriginOf(forged)).blockers).toContain('EVIDENCE_ORIGIN_UNTRUSTED');
    }
    expect(evaluateCompleteness(ok.evidence, NOW, 3_600_000, 'STRIPE_TEST_READ').blockers).toContain('EVIDENCE_ORIGIN_UNTRUSTED'); // sealed as mock but presented as real
    expect(evaluateCompleteness(ok.evidence, NOW, 3_600_000, 'MOCK_FIXTURE').blockers).toEqual([]);
  });

  it('boundary values and duplicate identifiers: page and item limits, duplicate line, payment and refund ids, zero and exact-total amounts', async () => {
    const dupLine = await run({ provider: fixture({ lines: onePage([...baseLines(), line('il_base', 0, subParent())]) }) });
    expect(dupLine.status).toBe('REJECTED'); if (dupLine.status === 'REJECTED') expect(dupLine.completeness.contradictions.join()).toMatch(/DUPLICATE/);
    expect((await run({ provider: fixture({ payments: onePage([pay(), pay()]) }) })).status).toBe('REJECTED');
    expect((await run({ provider: fixture({ refunds: onePage([refund(), refund()]) }) })).status).toBe('REJECTED');
    expect((await run({ provider: fixture({ refunds: pagesOf(Array.from({ length: 21 }, (_, i) => refund({ id: `re_${i}`, amount: 1 })), 1) }) })).status).toBe('REJECTED'); // 21 pages: beyond the page limit
    expect((await run({ provider: fixture({ refunds: pagesOf(Array.from({ length: 20 }, (_, i) => refund({ id: `re_${i}`, amount: 1, status: 'failed' })), 1) }) })).status).toBe('CLASSIFIED'); // exactly 20 pages
    expect((await run({ provider: fixture({ refunds: onePage([refund({ amount: 2700 })]) }) })).status).toBe('CLASSIFIED'); // equal to the payment
    expect((await run({ provider: fixture({ refunds: onePage([refund({ amount: 2701 })]) }) })).status).toBe('REJECTED'); // one more than the payment
    void itemParent; void BENEFIT_ITEM;
  });
});

function createMockProviderWithVersion(apiVersion: string) { return mockProvider({ apiVersion }); }
