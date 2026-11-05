/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acquireMockExtendedEvidence, classifyBundle, collectPages, createStripeGetTransport, decideCapability, EVIDENCE_CONTRACT_VERSION, MAX_ITEMS, MAX_PAGES, MockExtendedSource, normalizeDisputePages,
  normalizeInvoicePayments, normalizeLinePages, normalizeRefundPages, onePage, pagesOf, profileFor, refundExtent, ScriptedReadTransport, sealedOriginOf, StripeReadOnlyEvidenceAdapter, syntheticStripeInvoice,
  type ExtendedMockInput, type ReadAuthorization, type TrustedInvoiceScope,
} from './index';
import { adapterOver, gateFor } from './pipeline-fixtures';
import { assembleEvidence } from './bundle-builder';
import { benefitIdempotencyKey, type SettlementClassifierContext } from '../settlement-eligibility.classifier';
import type { RefundDisputeContext } from '../refund-dispute.classifier';

/**
 * S08-D1D3-DEV-07 acceptance tests. Synthetic Stripe-shaped fixtures and mock sources only: no network, no real key, no Stripe account. Provider shapes follow the SDK-schema profile, which is
 * NOT proven live (Q1/Q2); passing here proves the normalizers and the fail-closed rules, not that Stripe returns these fields. Numeric windows are TEST FIXTURES, not policy.
 */
const API = '2026-05-27.dahlia';
const ACCT = 'acct_TestSyntheticAccount1';
const NOW = 1_700_001_000_000;
const CREATED_S = 1_700_000_000; const PAID_S = 1_700_000_100;
const scope: TrustedInvoiceScope = { businessId: 'biz-1', invoiceId: 'in_1', customerId: 'cus_1', subscriptionId: 'sub_1' };
const KEY = benefitIdempotencyKey('res-1');
const D = (c: string) => c.repeat(64).slice(0, 64);
const AUTH: ReadAuthorization = { approved: true, revoked: false, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventoryRevision: 'rev-synthetic-1', accountId: ACCT, realm: 'test',
  methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'], expiresAtMs: NOW + 3_600_000 };

const invoice = (over: Record<string, unknown> = {}) => syntheticStripeInvoice(scope, { amount_due: 2700, amount_paid: 2700, amount_remaining: 0, total: 2700, created: CREATED_S,
  status_transitions: { finalized_at: CREATED_S, marked_uncollectible_at: null, paid_at: PAID_S, voided_at: null },
  lines: { object: 'list', has_more: false, data: [{ id: 'il_base', amount: 3000, currency: 'usd' }, { id: 'il_ben', amount: -300, currency: 'usd' }] }, ...over });
const subParent = (proration = false) => ({ type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { invoice_item: null, proration, subscription: 'sub_1', subscription_item: 'si_1' } });
const itemParent = (item: string | null = 'ii_ben') => ({ type: 'invoice_item_details', subscription_item_details: null, invoice_item_details: { invoice_item: item, proration: false, subscription: 'sub_1' } });
const line = (id: string, amount: number, parent: unknown, over: Record<string, unknown> = {}) => ({ id, object: 'line_item', amount, currency: 'usd', invoice: 'in_1', livemode: false, metadata: {}, parent, ...over });
const baseLines = () => [line('il_base', 3000, subParent()), line('il_ben', -300, itemParent())];
const pay = (over: Record<string, unknown> = {}) => ({ id: 'inpay_1', object: 'invoice_payment', amount_paid: 2700, amount_requested: 2700, created: CREATED_S + 50, currency: 'usd', invoice: 'in_1', is_default: true, livemode: false,
  payment: { type: 'payment_intent', payment_intent: 'pi_1' }, status: 'paid', status_transitions: { paid_at: PAID_S, canceled_at: null }, ...over });
const refund = (over: Record<string, unknown> = {}) => ({ id: 're_1', object: 'refund', amount: 500, charge: 'ch_1', created: PAID_S + 10, currency: 'usd', payment_intent: 'pi_1', status: 'succeeded', ...over });
const dispute = (over: Record<string, unknown> = {}) => ({ id: 'dp_1', object: 'dispute', amount: 2700, charge: 'ch_1', created: PAID_S + 10, currency: 'usd', livemode: false, payment_intent: 'pi_1', status: 'needs_response', ...over });
const frozen = [{ reservationId: 'res-1', providerIdempotencyKey: KEY, benefitMinor: 300 }];
const idem = [{ parentItemRef: 'ii_ben', idempotencyKey: KEY }];

type Fx = { lines?: any; payments?: any; refunds?: any; disputes?: any };
const input = (over: Partial<ExtendedMockInput> = {}, fx: Fx = {}): ExtendedMockInput => ({
  scope, accountId: ACCT, observedAtMs: NOW - 1_000, apiVersion: API, invoiceBefore: invoice(),
  source: new MockExtendedSource({ lines: fx.lines ?? onePage(baseLines()), payments: fx.payments ?? onePage([pay()]), refunds: fx.refunds ?? onePage([]), disputes: fx.disputes ?? onePage([]) }),
  frozen, idempotency: idem, billingInterval: 'month',
  benefitItem: { itemRef: 'ii_ben', invoiceRef: 'in_1', idempotencyKey: KEY, amountMinor: -300, currency: 'usd', discountable: false }, cancellation: 'none', ...over,
});
const acquire = async (over: Partial<ExtendedMockInput> = {}, fx: Fx = {}) => {
  const r = await acquireMockExtendedEvidence(input(over, fx));
  if (!r.ok) throw new Error(`denied ${r.denied}`);
  return r.evidence;
};
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
const classify = async (over: Partial<ExtendedMockInput> = {}, fx: Fx = {}) => classifyBundle(ctx(), await acquire(over, fx), binding, rdCtx());
const notEligible = (r: Awaited<ReturnType<typeof classify>>, why: string) => { expect(r.settlement.verdict, why).not.toBe('ELIGIBLE'); expect(r.settlement.grantsFinancialAuthority).toBe(false); };

const profile = profileFor(API)!;
const lineCtx = { invoiceId: 'in_1', currency: 'usd', totalMinor: 2700 as number | null, profile };
const lineOpts = { origin: 'MOCK_FIXTURE' as const, frozen, idempotency: idem };
const payCtx = { invoiceId: 'in_1', currency: 'usd', invoiceStatus: 'paid', invoicePaidMinor: 2700, invoiceCreatedAtMs: CREATED_S * 1000, observedAtMs: NOW, profile };
const histCtx = { businessId: 'biz-1', invoiceId: 'in_1', paymentRef: 'pi_1', target: { kind: 'payment_intent' as const, ref: 'pi_1' }, currency: 'usd', paidMinor: 2700, profile };

describe('A. contracts, profiles and pagination', () => {
  it('the evidence contract is versioned, and every fact is one of VERIFIED, CONFIRMED_ABSENT, UNRESOLVED, CONTRADICTORY', async () => {
    const e = await acquire();
    expect(e.contractVersion).toBe(EVIDENCE_CONTRACT_VERSION);
    const fields: any[] = [e.accountId, e.mode, e.invoice.id, e.invoice.status, e.invoice.currency, e.invoice.createdAtMs, e.invoice.paidAtMs, e.invoice.voidedAtMs, e.invoice.amounts, e.invoice.lines, e.lineAttribution, e.billingInterval,
      e.settlingPayment, e.refunds, e.disputes, e.stable];
    for (const f of fields) expect(['VERIFIED', 'CONFIRMED_ABSENT']).toContain(f.state);
    expect(e.invoice.voidedAtMs.state).toBe('CONFIRMED_ABSENT'); expect(e.refunds.state).toBe('CONFIRMED_ABSENT'); expect(e.disputes.state).toBe('CONFIRMED_ABSENT');
    expect(e.invoice.status).toMatchObject({ origin: 'MOCK_FIXTURE', mapping: 'PROVIDER_SCHEMA' });
  });

  it('22. a mapping exists only for an exact registered API version; any other version has no profile', () => {
    expect(profileFor(API)).toMatchObject({ apiVersion: API, proof: 'SDK_SCHEMA_UNPROVEN_LIVE' });
    for (const v of ['2025-01-01.acacia', '2026-06-24.dahlia', '2026-05-27', '2026-05-27.DAHLIA', ` ${API}`, `${API} `, '', '__proto__', 'constructor', 'toString', null, undefined, 20260527, {}, []]) expect(profileFor(v)).toBeNull();
  });

  it('pagination: complete only when the page sequence provably covers the list; boundaries at the page and item limits', () => {
    const id = (i: unknown) => (typeof (i as any)?.id === 'string' ? (i as any).id : null);
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}` }));
    expect(collectPages(onePage([]), id)).toEqual({ state: 'COMPLETE', items: [] });
    expect(collectPages(pagesOf(items(5), 2), id)).toMatchObject({ state: 'COMPLETE' });
    expect((collectPages(pagesOf(items(5), 2), id) as any).items).toHaveLength(5);
    expect(collectPages(pagesOf(items(MAX_PAGES), 1), id)).toMatchObject({ state: 'COMPLETE' }); // exactly the page limit
    expect(collectPages(pagesOf(items(MAX_PAGES + 1), 1), id)).toEqual({ state: 'INCOMPLETE', reason: 'TOO_MANY_PAGES' });
    expect(collectPages(pagesOf(items(MAX_ITEMS), 100).slice(0, 9), id)).toMatchObject({ state: 'INCOMPLETE' }); // truncated before the end
    expect(collectPages(pagesOf(items(MAX_ITEMS), 100), id)).toMatchObject({ state: 'COMPLETE' });
    expect(collectPages([{ requestedStartingAfter: null, body: { object: 'list', data: items(MAX_ITEMS + 1), has_more: false } }], id)).toEqual({ state: 'INCOMPLETE', reason: 'TOO_MANY_ITEMS' });
    expect(collectPages([{ requestedStartingAfter: null, body: { object: 'list', data: items(MAX_ITEMS), has_more: false } }], id)).toMatchObject({ state: 'COMPLETE' });
    const two = pagesOf(items(4), 2);
    expect(collectPages([two[0]!], id)).toEqual({ state: 'INCOMPLETE', reason: 'PAGINATION_INCOMPLETE' });
    expect(collectPages([two[0]!, { ...two[1]!, requestedStartingAfter: 'x0' }], id)).toEqual({ state: 'CONTRADICTORY', reason: 'PAGE_SEQUENCE_BROKEN' });
    expect(collectPages([{ ...two[0]!, requestedStartingAfter: 'x9' }, two[1]!], id)).toEqual({ state: 'CONTRADICTORY', reason: 'PAGE_SEQUENCE_BROKEN' });
    expect(collectPages([two[1]!, two[0]!], id)).toMatchObject({ state: 'CONTRADICTORY' });
    expect(collectPages([...two, two[1]!], id)).toMatchObject({ state: 'CONTRADICTORY' });
    expect(collectPages([{ requestedStartingAfter: null, body: { object: 'list', data: [], has_more: true } }], id)).toEqual({ state: 'MALFORMED', reason: 'EMPTY_PAGE_WITH_MORE' });
    for (const bad of [null, undefined, [], 'x', 5, {}, [null], [{}], [{ requestedStartingAfter: null }], [{ requestedStartingAfter: null, body: null }], [{ requestedStartingAfter: null, body: { object: 'charge', data: [], has_more: false } }],
      [{ requestedStartingAfter: null, body: { object: 'list', data: 'x', has_more: false } }], [{ requestedStartingAfter: null, body: { object: 'list', data: [], has_more: 'false' } }], [{ requestedStartingAfter: null, body: { object: 'list', data: [{}], has_more: false } }]] as any[])
      expect(['INCOMPLETE', 'MALFORMED']).toContain((collectPages(bad, id) as any).state);
    expect(collectPages(onePage([{ id: 'a' }, { id: 'a' }]), id)).toEqual({ state: 'CONTRADICTORY', reason: 'DUPLICATE_ITEM_ID' });
  });
});

describe('B. invoice-line normalization', () => {
  it('1. valid synthetic lines normalize: subscription lines are the base, the proven benefit line carries its parent item and idempotency key, and the frozen allocation is untouched', () => {
    const before = JSON.stringify(frozen);
    const r = normalizeLinePages(onePage(baseLines()), lineCtx, lineOpts);
    expect(r.lines).toMatchObject({ state: 'VERIFIED', value: { pageComplete: true, items: [{ lineRef: 'il_base', amountMinor: 3000, currency: 'usd' }, { lineRef: 'il_ben', amountMinor: -300, currency: 'usd' }] } });
    expect(r.attribution.value).toEqual([
      { lineRef: 'il_base', category: 'recurring_base', parentItemRef: null, parentItemKey: null, labelReservationRef: null },
      { lineRef: 'il_ben', category: 'benefit', parentItemRef: 'ii_ben', parentItemKey: KEY, labelReservationRef: null }]);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(normalizeLinePages(onePage([line('il_p', 100, subParent(true)), ...baseLines()]), { ...lineCtx, totalMinor: 2800 }, lineOpts).attribution.value![0]).toMatchObject({ category: 'proration' });
    // multi-page lists are accepted when the sequence is provably complete
    expect(normalizeLinePages(pagesOf(baseLines(), 1), lineCtx, lineOpts).lines.state).toBe('VERIFIED');
  });

  it('2. incomplete pagination fails closed (lines and attribution UNRESOLVED), and a broken sequence is a contradiction', () => {
    const pages = pagesOf(baseLines(), 1);
    for (const r of [normalizeLinePages([pages[0]!], lineCtx, lineOpts), normalizeLinePages([], lineCtx, lineOpts), normalizeLinePages(null, lineCtx, lineOpts)]) { expect(r.lines.state).toBe('UNRESOLVED'); expect(r.attribution.state).toBe('UNRESOLVED'); expect(r.lines.value).toBeNull(); }
    expect(normalizeLinePages([pages[0]!, { ...pages[1]!, requestedStartingAfter: 'il_x' }], lineCtx, lineOpts).lines.state).toBe('CONTRADICTORY');
  });

  it('3. duplicate line identifiers are contradictory, within a page and across pages', () => {
    expect(normalizeLinePages(onePage([...baseLines(), line('il_base', 5, subParent())]), lineCtx, lineOpts).lines).toMatchObject({ state: 'CONTRADICTORY', reason: 'DUPLICATE_ITEM_ID' });
    const dup = [{ requestedStartingAfter: null, body: { object: 'list', data: [baseLines()[0]], has_more: true } }, { requestedStartingAfter: 'il_base', body: { object: 'list', data: [baseLines()[0]], has_more: false } }];
    expect(normalizeLinePages(dup, lineCtx, lineOpts).lines.state).toBe('CONTRADICTORY');
  });

  it('4. currency mismatches are contradictions: another currency on a line, malformed currency, a different invoice currency, lines for another invoice', () => {
    expect(normalizeLinePages(onePage([line('il_base', 3000, subParent()), line('il_ben', -300, itemParent(), { currency: 'eur' })]), lineCtx, lineOpts).lines).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('LINE_CURRENCY_MISMATCH') });
    expect(normalizeLinePages(onePage(baseLines()), { ...lineCtx, currency: 'eur' }, lineOpts).lines.state).toBe('CONTRADICTORY');
    expect(normalizeLinePages(onePage([line('il_base', 3000, subParent(), { currency: 'USD' }), baseLines()[1]]), lineCtx, lineOpts).lines.state).toBe('UNRESOLVED');
    expect(normalizeLinePages(onePage([line('il_base', 3000, subParent(), { invoice: 'in_other' }), baseLines()[1]]), lineCtx, lineOpts).lines).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('LINE_FOR_OTHER_INVOICE') });
    expect(normalizeLinePages(onePage([line('il_base', 3000, subParent(), { livemode: true }), baseLines()[1]]), lineCtx, lineOpts).lines).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('LINE_LIVEMODE_NOT_TEST') });
    expect(normalizeLinePages(onePage(baseLines()), { ...lineCtx, totalMinor: 2699 }, lineOpts).lines).toMatchObject({ state: 'CONTRADICTORY', reason: 'LINES_TOTAL_MISMATCH' });
  });

  it('5. missing parent-item references leave the attribution UNRESOLVED: an invoice-item line with no item, a negative line with no idempotency evidence, no frozen allocation to match', () => {
    const noItem = normalizeLinePages(onePage([baseLines()[0], line('il_ben', -300, itemParent(null))]), lineCtx, lineOpts);
    expect(noItem.lines.state).toBe('VERIFIED'); expect(noItem.attribution).toMatchObject({ state: 'UNRESOLVED', reason: 'PARENT_ITEM_MISSING' });
    expect(normalizeLinePages(onePage(baseLines()), lineCtx, { ...lineOpts, idempotency: null }).attribution).toMatchObject({ state: 'UNRESOLVED', reason: 'BENEFIT_ATTRIBUTION_UNPROVEN' });
    expect(normalizeLinePages(onePage(baseLines()), lineCtx, { ...lineOpts, idempotency: [] }).attribution.state).toBe('UNRESOLVED');
    expect(normalizeLinePages(onePage(baseLines()), lineCtx, { ...lineOpts, frozen: null }).attribution).toMatchObject({ state: 'UNRESOLVED', reason: 'FROZEN_ALLOCATION_UNAVAILABLE' });
    for (const parent of [null, {}, { type: 'something_new' }, { type: 'invoice_item_details' }, { type: 'subscription_item_details', subscription_item_details: { proration: 'no' } }, 'x'])
      expect(normalizeLinePages(onePage([baseLines()[0], line('il_ben', -300, parent)]), lineCtx, lineOpts).lines).toMatchObject({ state: 'UNRESOLVED', reason: expect.stringContaining('SCHEMA_DRIFT') });
  });

  it('6. invalid benefit-application evidence is rejected: fabricated lines, wrong amounts, mismatched or misplaced labels, conflicting idempotency evidence, malformed metadata', () => {
    const attr = (lines: unknown[], o: Partial<typeof lineOpts> = {}, total = lineCtx.totalMinor) => normalizeLinePages(onePage(lines), { ...lineCtx, totalMinor: total }, { ...lineOpts, ...o });
    expect(attr(baseLines(), { idempotency: [{ parentItemRef: 'ii_ben', idempotencyKey: 'benefit-apply:v1:res-OTHER' }] }).attribution).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('FABRICATED_BENEFIT_LINE') });
    expect(attr([baseLines()[0], line('il_ben', -250, itemParent())], {}, 2750).attribution).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('BENEFIT_AMOUNT_MISMATCH') });
    expect(attr([baseLines()[0], line('il_ben', -300, itemParent(), { metadata: { echogrid_reservation_ref: 'res-OTHER' } })]).attribution).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('BENEFIT_LABEL_MISMATCH') });
    expect(attr([baseLines()[0], line('il_ben', -300, itemParent(), { metadata: { echogrid_reservation_ref: 'res-1' } })]).attribution.state).toBe('VERIFIED'); // label agrees with the proven key
    expect(attr([baseLines()[0], line('il_ben', -300, itemParent(), { metadata: { echogrid_reservation_ref: 'res-1' } })], { idempotency: [] }).attribution).toMatchObject({ state: 'UNRESOLVED', reason: 'UNVERIFIABLE_BENEFIT_LINE' }); // a label alone proves nothing
    expect(attr([line('il_base', 3000, subParent(), { metadata: { echogrid_reservation_ref: 'res-1' } }), baseLines()[1]]).attribution).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('BENEFIT_LABEL_ON_SUBSCRIPTION_LINE') });
    expect(attr([baseLines()[0], line('il_charge', 300, itemParent('ii_x'), { metadata: { echogrid_reservation_ref: 'res-1' } }), baseLines()[1]], {}, 3000).attribution).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('FABRICATED_BENEFIT_LINE') });
    expect(attr(baseLines(), { idempotency: [...idem, { parentItemRef: 'ii_ben', idempotencyKey: 'benefit-apply:v1:res-9' }] }).attribution.state).toBe('CONTRADICTORY');
    expect(attr([baseLines()[0], line('il_b2', -300, itemParent('ii_b2')), baseLines()[1]], { idempotency: [...idem, { parentItemRef: 'ii_b2', idempotencyKey: KEY }] }, 2400).attribution).toMatchObject({ state: 'CONTRADICTORY', reason: expect.stringContaining('DUPLICATE_EFFECT') });
    for (const metadata of ['x', 5, [], { echogrid_reservation_ref: 5 }, { a: null }]) expect(attr([baseLines()[0], line('il_ben', -300, itemParent(), { metadata })]).lines).toMatchObject({ state: 'UNRESOLVED', reason: expect.stringContaining('METADATA_MALFORMED') });
    // the frozen allocation is read, never recomputed
    expect(frozen).toEqual([{ reservationId: 'res-1', providerIdempotencyKey: KEY, benefitMinor: 300 }]);
  });

  it('boundary values and malformed runtime input for lines never throw and never verify', () => {
    for (const amount of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity, '300', null, undefined, {}]) expect(normalizeLinePages(onePage([baseLines()[0], line('il_ben', amount as any, itemParent())]), lineCtx, lineOpts).lines.state).toBe('UNRESOLVED');
    expect(normalizeLinePages(onePage([line('il_z', 0, subParent())]), { ...lineCtx, totalMinor: 0 }, lineOpts).lines.state).toBe('VERIFIED'); // a zero line is a valid line
    expect(normalizeLinePages(onePage([line('il_m', -0, subParent())]), { ...lineCtx, totalMinor: 0 }, lineOpts).lines.state).toBe('VERIFIED');
    for (const id of ['', ' ', 'a b', 'a'.repeat(256), '../x', 5 as any, null as any]) expect(normalizeLinePages(onePage([{ ...baseLines()[0], id }]), lineCtx, lineOpts).lines.state).toBe('UNRESOLVED');
    for (const c of [{ ...lineCtx, profile: null }, { ...lineCtx, profile: { ...profile, categories: [] } }]) expect(normalizeLinePages(onePage(baseLines()), c as any, lineOpts)).toMatchObject({ lines: { state: 'UNRESOLVED', reason: 'API_VERSION_UNSUPPORTED' }, drift: ['API_VERSION_UNSUPPORTED:invoice_lines'] });
  });
});

describe('C. payment evidence normalization', () => {
  it('a paid invoice with exactly one coherent paid invoice payment yields a verified settling payment with its identity, amount and time', () => {
    const r = normalizeInvoicePayments(onePage([pay(), pay({ id: 'inpay_open', status: 'open', amount_paid: null, status_transitions: { paid_at: null, canceled_at: null } }), pay({ id: 'inpay_c', status: 'canceled', amount_paid: null, status_transitions: { paid_at: null, canceled_at: PAID_S } })]), payCtx, 'MOCK_FIXTURE');
    expect(r.payment).toMatchObject({ state: 'VERIFIED', value: { ref: 'pi_1', source: 'stripe_payment', details: { paymentRecordRef: 'inpay_1', kind: 'payment_intent', amountMinor: 2700, currency: 'usd', paidAtMs: PAID_S * 1000 } } });
    expect(normalizeInvoicePayments(onePage([pay({ payment: { type: 'charge', charge: 'ch_9' } })]), payCtx, 'MOCK_FIXTURE').payment.value).toMatchObject({ ref: 'ch_9', details: { kind: 'charge' } });
    expect(normalizeInvoicePayments(onePage([pay({ payment: { type: 'payment_intent', payment_intent: { id: 'pi_exp' } } })]), payCtx, 'MOCK_FIXTURE').payment.value!.ref).toBe('pi_exp');
  });

  it('7. a payment associated with another invoice is a contradiction and never settles this one', async () => {
    for (const invoiceField of ['in_other', { id: 'in_other' }]) expect(normalizeInvoicePayments(onePage([pay({ invoice: invoiceField })]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'CONTRADICTORY', reason: 'PAYMENT_FOR_OTHER_INVOICE' });
    expect(normalizeInvoicePayments(onePage([pay(), pay({ id: 'inpay_2', invoice: 'in_other', payment: { type: 'payment_intent', payment_intent: 'pi_2' } })]), payCtx, 'MOCK_FIXTURE').payment.state).toBe('CONTRADICTORY');
    const e = await acquire({}, { payments: onePage([pay({ invoice: 'in_other' })]) });
    expect(e.settlingPayment.state).toBe('CONTRADICTORY'); expect(e.complete).toBe(false);
    notEligible(classifyBundle(ctx(), e, binding, rdCtx()) as any, 'payment of another invoice');
  });

  it('8. missing settlement confirmation: a paid label alone is not settlement', async () => {
    for (const payments of [onePage([]), onePage([pay({ status: 'open', amount_paid: null, status_transitions: { paid_at: null, canceled_at: null } })]), onePage([pay({ status: 'canceled', amount_paid: null, status_transitions: { paid_at: null, canceled_at: PAID_S } })])]) {
      expect(normalizeInvoicePayments(payments, payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'UNRESOLVED', reason: 'SETTLEMENT_CONFIRMATION_MISSING' });
      const r = await classify({}, { payments });
      expect((await acquire({}, { payments })).complete).toBe(false);
      notEligible(r, 'invoice labelled paid without a settling payment');
    }
    expect(normalizeInvoicePayments(onePage([pay({ payment: { type: 'payment_record', payment_record: 'pr_1' } })]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'UNRESOLVED', reason: 'PAYMENT_TYPE_UNSUPPORTED' });
    expect(normalizeInvoicePayments(onePage([pay()]), { ...payCtx, invoiceStatus: 'open', invoicePaidMinor: 0 }, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'UNRESOLVED', reason: 'INVOICE_NOT_SETTLED' });
    expect(normalizeInvoicePayments(pagesOf([pay()], 1).slice(0, 0), payCtx, 'MOCK_FIXTURE').payment.state).toBe('UNRESOLVED');
  });

  it('9. duplicate or contradictory payment evidence fails closed: one payment named twice, two settling payments, an amount or currency that disagrees, a live payment', () => {
    const second = (over: Record<string, unknown>) => pay({ id: 'inpay_2', ...over });
    expect(normalizeInvoicePayments(onePage([pay(), second({})]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'CONTRADICTORY', reason: 'DUPLICATE_PAYMENT_REFERENCE' });
    expect(normalizeInvoicePayments(onePage([pay(), second({ payment: { type: 'payment_intent', payment_intent: 'pi_2' } })]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'UNRESOLVED', reason: 'MULTIPLE_SETTLING_PAYMENTS' });
    expect(normalizeInvoicePayments(onePage([pay(), pay()]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'CONTRADICTORY', reason: 'DUPLICATE_ITEM_ID' });
    expect(normalizeInvoicePayments(onePage([pay({ amount_paid: 2600 })]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'CONTRADICTORY', reason: 'PAYMENT_AMOUNT_MISMATCH' });
    expect(normalizeInvoicePayments(onePage([pay({ currency: 'eur' })]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'CONTRADICTORY', reason: 'PAYMENT_CURRENCY_MISMATCH' });
    expect(normalizeInvoicePayments(onePage([pay({ livemode: true })]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'CONTRADICTORY', reason: 'PAYMENT_LIVEMODE_NOT_TEST' });
    for (const amount of [0, -1, 1.5, NaN, '2700', null, undefined]) expect(normalizeInvoicePayments(onePage([pay({ amount_paid: amount })]), payCtx, 'MOCK_FIXTURE').payment.state).toBe('UNRESOLVED');
  });

  it('10. invalid payment timestamps are rejected; the boundaries (equal to creation, equal to the observation) are accepted and one step beyond is not', () => {
    const at = (paid_at: unknown) => normalizeInvoicePayments(onePage([pay({ status_transitions: { paid_at, canceled_at: null } })]), payCtx, 'MOCK_FIXTURE').payment;
    expect(at(null)).toMatchObject({ state: 'CONTRADICTORY', reason: 'PAID_WITHOUT_PAID_AT' });
    for (const bad of ['x', 1.5, -1, {}, [], Number.MAX_SAFE_INTEGER, NaN, true]) expect(at(bad).state).toBe('UNRESOLVED');
    expect(normalizeInvoicePayments(onePage([pay({ status_transitions: undefined })]), payCtx, 'MOCK_FIXTURE').payment).toMatchObject({ state: 'UNRESOLVED', reason: 'PAYMENT_PAID_AT_MISSING' });
    expect(normalizeInvoicePayments(onePage([pay({ status_transitions: {} })]), payCtx, 'MOCK_FIXTURE').payment.state).toBe('UNRESOLVED');
    expect(at(CREATED_S - 1)).toMatchObject({ state: 'CONTRADICTORY', reason: 'PAYMENT_BEFORE_INVOICE_CREATION' });
    expect(at(CREATED_S).state).toBe('VERIFIED');
    expect(at(NOW / 1000).state).toBe('VERIFIED');
    expect(at(NOW / 1000 + 1)).toMatchObject({ state: 'CONTRADICTORY', reason: 'PAYMENT_PAID_AT_IN_FUTURE' });
  });
});

describe('D. refund and dispute evidence', () => {
  it('a complete empty history is CONFIRMED_ABSENT; a history with items is VERIFIED with identity, payment, status and amount; statuses map literally', () => {
    expect(normalizeRefundPages(onePage([]), histCtx, 'MOCK_FIXTURE').refunds.state).toBe('CONFIRMED_ABSENT');
    expect(normalizeDisputePages(onePage([]), histCtx, 'MOCK_FIXTURE').disputes.state).toBe('CONFIRMED_ABSENT');
    const statuses = { pending: 'pending', requires_action: 'requires_action', succeeded: 'succeeded', failed: 'failed', canceled: 'canceled' } as const;
    for (const [s, f] of Object.entries(statuses)) expect(normalizeRefundPages(onePage([refund({ status: s })]), histCtx, 'MOCK_FIXTURE').refunds.value!.items[0]).toEqual({ id: 're_1', businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', amountMinor: 500, finality: f, finalizedAtMs: null });
    const outcomes = { won: 'won', lost: 'lost', needs_response: 'open', under_review: 'open', warning_needs_response: 'unknown', warning_under_review: 'unknown', warning_closed: 'unknown', prevented: 'unknown' } as const;
    for (const [s, o] of Object.entries(outcomes)) expect(normalizeDisputePages(onePage([dispute({ status: s })]), histCtx, 'MOCK_FIXTURE').disputes.value!.items[0]).toMatchObject({ outcome: o, overlapsRefundIds: null, paymentRef: 'pi_1' });
    const viaCharge = { ...histCtx, target: { kind: 'charge' as const, ref: 'ch_1' }, paymentRef: 'ch_1' };
    expect(normalizeRefundPages(onePage([refund({ payment_intent: null })]), viaCharge, 'MOCK_FIXTURE').refunds.state).toBe('VERIFIED');
    expect(normalizeDisputePages(onePage([dispute({ payment_intent: null })]), viaCharge, 'MOCK_FIXTURE').disputes.state).toBe('VERIFIED');
  });

  it('11. a refund or dispute associated with another payment is a contradiction; one that names no comparable payment is unattributable, not assumed to be ours', () => {
    expect(normalizeRefundPages(onePage([refund({ payment_intent: 'pi_other' })]), histCtx, 'MOCK_FIXTURE').refunds).toMatchObject({ state: 'CONTRADICTORY', reason: 'REFUND_FOR_OTHER_PAYMENT' });
    expect(normalizeRefundPages(onePage([refund(), refund({ id: 're_2', payment_intent: { id: 'pi_other' } })]), histCtx, 'MOCK_FIXTURE').refunds.state).toBe('CONTRADICTORY');
    expect(normalizeRefundPages(onePage([refund({ payment_intent: null })]), histCtx, 'MOCK_FIXTURE').refunds).toMatchObject({ state: 'UNRESOLVED', reason: 'REFUND_PAYMENT_ASSOCIATION_UNPROVEN' });
    expect(normalizeDisputePages(onePage([dispute({ payment_intent: 'pi_other' })]), histCtx, 'MOCK_FIXTURE').disputes).toMatchObject({ state: 'CONTRADICTORY', reason: 'DISPUTE_FOR_OTHER_PAYMENT' });
    expect(normalizeDisputePages(onePage([dispute({ payment_intent: null })]), histCtx, 'MOCK_FIXTURE').disputes).toMatchObject({ state: 'UNRESOLVED', reason: 'DISPUTE_PAYMENT_ASSOCIATION_UNPROVEN' });
    expect(normalizeRefundPages(onePage([refund({ currency: 'eur' })]), histCtx, 'MOCK_FIXTURE').refunds.state).toBe('CONTRADICTORY');
    expect(normalizeDisputePages(onePage([dispute({ livemode: true })]), histCtx, 'MOCK_FIXTURE').disputes.state).toBe('CONTRADICTORY');
  });

  it('12. partial refunds keep their amount and status; the total is bounded by the payment (boundary: equal is accepted, one more is a contradiction)', async () => {
    const r = await classify({}, { refunds: onePage([refund({ amount: 500 })]) });
    expect(refundExtent(await acquire({}, { refunds: onePage([refund({ amount: 500 })]) }), 2700)).toBe('partial');
    expect(r.refundDispute?.classification).toBe('PARTIAL_REFUND_VERIFIED');
    notEligible(r, 'partial refund');
    expect(normalizeRefundPages(onePage([refund({ amount: 2700 })]), histCtx, 'MOCK_FIXTURE').refunds.state).toBe('VERIFIED');
    expect(normalizeRefundPages(onePage([refund({ amount: 2701 })]), histCtx, 'MOCK_FIXTURE').refunds).toMatchObject({ state: 'CONTRADICTORY', reason: 'REFUND_TOTAL_EXCEEDS_PAYMENT' });
    expect(normalizeRefundPages(onePage([refund({ amount: 1500 }), refund({ id: 're_2', amount: 1201 })]), histCtx, 'MOCK_FIXTURE').refunds.state).toBe('CONTRADICTORY');
    expect(normalizeRefundPages(onePage([refund({ amount: 1500 }), refund({ id: 're_2', amount: 1200 })]), histCtx, 'MOCK_FIXTURE').refunds.state).toBe('VERIFIED');
    const full = await classify({}, { refunds: onePage([refund({ amount: 2700 })]) });
    expect(full.settlement).toMatchObject({ verdict: 'INELIGIBLE', reasonCodes: ['REFUNDED'] });
    for (const amount of [0, -5, 1.5, '500', null]) expect(normalizeRefundPages(onePage([refund({ amount })]), histCtx, 'MOCK_FIXTURE').refunds.state).toBe('UNRESOLVED');
  });

  it('13. failed and canceled refunds are preserved with their status, move no money in the totals, and never read as "no refund"', async () => {
    for (const status of ['failed', 'canceled'] as const) {
      const e = await acquire({}, { refunds: onePage([refund({ status, amount: 5000 })]) }); // larger than the payment, but it moved nothing
      expect(e.refunds).toMatchObject({ state: 'VERIFIED', value: { items: [{ finality: status, amountMinor: 5000 }] } });
      expect(refundExtent(e, 2700)).toBe('unknown');
      notEligible(classifyBundle(ctx(), e, binding, rdCtx()) as any, `${status} refund`);
    }
  });

  it('14. open disputes cannot authorize consumption (needs_response and under_review are open)', async () => {
    for (const status of ['needs_response', 'under_review']) {
      const r = await classify({}, { disputes: onePage([dispute({ status })]) });
      expect(r.refundDispute?.classification).toBe('DISPUTE_OPEN');
      expect(r.settlement.reasonCodes).toContain('DISPUTE_OPEN');
      notEligible(r, status);
    }
    notEligible(await classify({}, { disputes: onePage([dispute({ status: 'warning_needs_response' })]) }), 'inquiry states are unknown, not "none"');
    notEligible(await classify({}, { disputes: onePage([dispute({ status: 'prevented' })]) }), 'prevented is not a confirmed absence');
  });

  it('15. lost disputes classify as a payment-dispute loss; a won dispute is not a loss but is not an absence either', async () => {
    const lost = await classify({}, { disputes: onePage([dispute({ status: 'lost' })]) });
    expect(lost.settlement).toMatchObject({ verdict: 'INELIGIBLE', reasonCodes: ['PAYMENT_DISPUTE_LOST'] });
    expect(lost.refundDispute?.classification).toBe('DISPUTE_LOST_VERIFIED');
    const won = await classify({}, { disputes: onePage([dispute({ status: 'won' })]) });
    expect(won.refundDispute?.classification).toBe('DISPUTE_WON_VERIFIED');
    expect(won.settlement.reasonCodes).not.toContain('PAYMENT_DISPUTE_LOST');
  });

  it('16. multiple disputes on the same payment remain fail-closed under the existing policy', async () => {
    const e = await acquire({}, { disputes: onePage([dispute({ id: 'dp_1', status: 'lost', amount: 1000 }), dispute({ id: 'dp_2', status: 'won', amount: 1000 })]) });
    expect(e.contradictions).toContain('MULTIPLE_DISPUTES_ON_PAYMENT'); expect(e.complete).toBe(false);
    expect(e.disputes.state).toBe('VERIFIED'); // preserved, not discarded
    const r = classifyBundle(ctx(), e, binding, rdCtx());
    expect(r.refundDispute).toMatchObject({ classification: 'CONTRADICTORY_EVIDENCE', reasonCodes: expect.arrayContaining(['MULTIPLE_DISPUTES_UNDEFINED']) });
    expect(r.settlement.verdict).toBe('UNRESOLVED');
  });

  it('17. refund/dispute overlap is detected and kept undetermined; loss totals that cannot be right are rejected', async () => {
    const e = await acquire({}, { refunds: onePage([refund({ amount: 1000 })]), disputes: onePage([dispute({ status: 'lost', amount: 1700 })]) });
    expect(e.contradictions).toContain('REFUND_DISPUTE_OVERLAP_UNDETERMINED'); expect(e.complete).toBe(false);
    expect(e.disputes.value!.items[0]!.overlapsRefundIds).toBeNull(); // the provider does not say; it is never guessed or summed
    const r = classifyBundle(ctx(), e, binding, rdCtx());
    expect(r.refundDispute?.classification).toBe('CONTRADICTORY_EVIDENCE');
    expect(r.settlementEvidence?.events).toMatchObject({ refund: 'unknown', dispute: 'unknown' }); // preserved as manual review, never as a positive or a partial loss
    expect(classifyBundle(ctx(), e, binding, null).settlementEvidence?.events).toMatchObject({ refund: 'unknown', dispute: 'unknown' }); // the same without the D3 context: the bundle's own contradiction decides
    notEligible(r as any, 'undetermined overlap');
    expect(normalizeDisputePages(onePage([dispute({ status: 'lost', amount: 2701 })]), histCtx, 'MOCK_FIXTURE').disputes).toMatchObject({ state: 'CONTRADICTORY', reason: 'DISPUTE_TOTAL_EXCEEDS_PAYMENT' });
    expect(normalizeDisputePages(onePage([dispute({ status: 'lost', amount: 2700 })]), histCtx, 'MOCK_FIXTURE').disputes.state).toBe('VERIFIED'); // equal to the payment is accepted
    // a failed refund beside a dispute is not an overlap
    expect((await acquire({}, { refunds: onePage([refund({ status: 'failed' })]), disputes: onePage([dispute({ status: 'lost' })]) })).contradictions).not.toContain('REFUND_DISPUTE_OVERLAP_UNDETERMINED');
  });

  it('18. incomplete refund/dispute history is never read as confirmed absence', async () => {
    const two = pagesOf([refund({ id: 're_1' }), refund({ id: 're_2', amount: 100 })], 1);
    for (const pages of [[two[0]!], [], null, undefined, [{ requestedStartingAfter: null, body: { object: 'list', data: [], has_more: true } }], [{ requestedStartingAfter: null, body: 'x' }]] as any[]) {
      expect(normalizeRefundPages(pages, histCtx, 'MOCK_FIXTURE').refunds.state).toBe('UNRESOLVED');
      expect(normalizeDisputePages(pages, histCtx, 'MOCK_FIXTURE').disputes.state).toBe('UNRESOLVED');
    }
    const e = await acquire({}, { refunds: [two[0]!], disputes: [] });
    expect(e.refunds.state).toBe('UNRESOLVED'); expect(e.disputes.state).toBe('UNRESOLVED'); expect(e.complete).toBe(false);
    expect(refundExtent(e, 2700)).toBe('unknown');
    const r = classifyBundle(ctx(), e, binding, rdCtx());
    expect(r.refundDispute?.classification).not.toBe('NO_REFUND'); notEligible(r as any, 'incomplete history');
    // without a verified settling payment there is no payment to attach a history to
    const noPay = await acquire({}, { payments: onePage([]) });
    expect(noPay.refunds).toMatchObject({ state: 'UNRESOLVED', reason: 'PAYMENT_TARGET_UNKNOWN' });
  });
});

describe('E. accounts, modes, drift, required fields', () => {
  it('19. wrong Stripe account: the real adapter refuses another account before any invoice read, and the classifier refuses a mismatched account', async () => {
    const transport = new ScriptedReadTransport([{ object: 'account', id: 'acct_SomeOtherAccount' }, invoice()]);
    const adapter = adapterOver({ transport, gate: gateFor(AUTH), expectedAccountId: ACCT, clock: () => NOW, audit: () => undefined });
    expect(await adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'ACCOUNT_MISMATCH' });
    expect(transport.calls.map(c => c.method)).toEqual(['ACCOUNT_RETRIEVE_CURRENT']);
    const r = classifyBundle(ctx({ expected: { ...ctx().expected, providerAccountId: 'acct_Other' } }), await acquire(), binding, rdCtx());
    expect(r.settlement.reasonCodes).toContain('SCOPE_MISMATCH');
  });

  it('20. wrong Stripe mode: a live invoice is a denial; live lines, payments and disputes are contradictions; the classifier refuses a live-mode expectation', async () => {
    expect(await acquireMockExtendedEvidence(input({ invoiceBefore: invoice({ livemode: true }) }))).toEqual({ ok: false, denied: 'REALM_MISMATCH' });
    for (const livemode of [undefined, null, 'false', 0]) expect(await acquireMockExtendedEvidence(input({ invoiceBefore: invoice({ livemode }) }))).toEqual({ ok: false, denied: 'REALM_MISMATCH' });
    expect((await acquire({}, { lines: onePage([line('il_base', 3000, subParent(), { livemode: true }), baseLines()[1]]) })).invoice.lines.state).toBe('CONTRADICTORY');
    expect((await acquire({}, { payments: onePage([pay({ livemode: true })]) })).settlingPayment.state).toBe('CONTRADICTORY');
    expect((await acquire({}, { disputes: onePage([dispute({ livemode: true })]) })).disputes.state).toBe('CONTRADICTORY');
    const r = classifyBundle(ctx({ expected: { ...ctx().expected, providerMode: 'live' } }), await acquire(), binding, rdCtx());
    expect(r.settlement.reasonCodes).toContain('SCOPE_MISMATCH');
    const wrongTenant = classifyBundle(ctx(), await acquire(), { ...binding, businessId: 'biz-2' }, rdCtx());
    expect(wrongTenant.settlement.reasonCodes).toContain('TENANT_MISMATCH');
  });

  it('21. provider response schema drift is detected, recorded and fails closed: unknown enum values, changed object names, changed field types, changed list shapes', async () => {
    const cases: Array<[string, Fx]> = [
      ['payment status', { payments: onePage([pay({ status: 'refunded' })]) }],
      ['payment object', { payments: onePage([pay({ object: 'payment' })]) }],
      ['refund status', { refunds: onePage([refund({ status: 'reversed' })]), }],
      ['refund amount type', { refunds: onePage([refund({ amount: '500' })]) }],
      ['dispute status', { disputes: onePage([dispute({ status: 'closed' })]) }],
      ['dispute object', { disputes: onePage([dispute({ object: 'chargeback' })]) }],
      ['line parent type', { lines: onePage([baseLines()[0], line('il_ben', -300, { type: 'schedule_details' })]) }],
      ['line object', { lines: onePage([{ ...baseLines()[0], object: 'invoiceitem' }, baseLines()[1]]) }],
      ['list shape', { lines: [{ requestedStartingAfter: null, body: { object: 'collection', data: baseLines(), has_more: false } }] }],
    ];
    for (const [label, fx] of cases) {
      const e = await acquire({}, fx);
      expect(e.complete, label).toBe(false);
      expect(e.schemaDrift.length, label).toBeGreaterThan(0);
      notEligible(classifyBundle(ctx(), e, binding, rdCtx()) as any, label);
    }
    // unknown ADDITIONAL fields are tolerated (the provider adds fields); they change nothing
    const extra = await acquire({}, { payments: onePage([pay({ brand_new_field: { a: 1 } })]), refunds: onePage([refund({ extra: 1 })]) });
    expect(extra.settlingPayment.state).toBe('VERIFIED'); expect(extra.refunds.state).toBe('VERIFIED');
  });

  it('22. an unsupported API version maps nothing: every fact is UNRESOLVED, the source is never read, and the bundle is never complete', async () => {
    for (const apiVersion of ['2025-01-01.acacia', '', '__proto__', ` ${API}`]) {
      const source = new MockExtendedSource({ lines: onePage(baseLines()), payments: onePage([pay()]) });
      const r = await acquireMockExtendedEvidence(input({ apiVersion, source }));
      if (!r.ok) throw new Error('expected a bundle');
      expect(source.calls).toEqual([]);
      expect(r.evidence.schemaDrift).toContain('API_VERSION_UNSUPPORTED'); expect(r.evidence.complete).toBe(false);
      for (const f of [r.evidence.invoice.status, r.evidence.invoice.amounts, r.evidence.invoice.lines, r.evidence.settlingPayment, r.evidence.refunds, r.evidence.disputes, r.evidence.lineAttribution]) expect(f).toMatchObject({ state: 'UNRESOLVED', reason: 'API_VERSION_UNSUPPORTED' });
      notEligible(classifyBundle(ctx(), r.evidence, binding, rdCtx()) as any, apiVersion);
    }
    const t = new ScriptedReadTransport([{ object: 'account', id: ACCT }, invoice()]);
    const adapter = adapterOver({ transport: t, gate: gateFor(AUTH), expectedAccountId: ACCT, clock: () => NOW, audit: () => undefined, apiVersion: '2025-01-01.acacia' });
    expect(await adapter.acquire(scope)).toEqual({ ok: false, kind: 'DENIED', reason: 'UNSUPPORTED_API_VERSION' });
    expect(t.calls).toEqual([]);
  });

  it('23. missing required provider fields leave the fact unresolved (never defaulted): every required key of every object, one at a time', async () => {
    const drop = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };
    for (const k of ['id', 'object', 'amount', 'currency', 'invoice', 'livemode', 'parent']) {
      const n = normalizeLinePages(onePage([drop(baseLines()[0] as any, k), baseLines()[1]]), lineCtx, lineOpts);
      expect(n.lines.state === 'VERIFIED', `line without ${k}`).toBe(false);
    }
    for (const k of ['id', 'object', 'amount_paid', 'currency', 'invoice', 'livemode', 'payment', 'status', 'status_transitions']) {
      expect(normalizeInvoicePayments(onePage([drop(pay(), k)]), payCtx, 'MOCK_FIXTURE').payment.state === 'VERIFIED', `payment without ${k}`).toBe(false);
    }
    for (const k of ['id', 'object', 'amount', 'currency', 'status', 'created']) expect(normalizeRefundPages(onePage([drop(refund(), k)]), histCtx, 'MOCK_FIXTURE').refunds.state === 'VERIFIED', `refund without ${k}`).toBe(false);
    for (const k of ['id', 'object', 'amount', 'currency', 'status', 'livemode']) expect(normalizeDisputePages(onePage([drop(dispute(), k)]), histCtx, 'MOCK_FIXTURE').disputes.state === 'VERIFIED', `dispute without ${k}`).toBe(false);
    for (const k of ['status', 'currency', 'created', 'amount_due', 'amount_paid', 'amount_remaining', 'total', 'status_transitions', 'customer', 'parent']) {
      const r = await acquireMockExtendedEvidence(input({ invoiceBefore: drop(invoice(), k) }));
      if (!r.ok) continue; // identity-bearing absence is a denial
      expect(r.evidence.complete, `invoice without ${k}`).toBe(false);
      notEligible(classifyBundle(ctx(), r.evidence, binding, rdCtx()) as any, `invoice without ${k}`);
    }
  });
});

describe('F. classifier bridge, origin and determinism', () => {
  it('25. positive mock classification: complete, valid, source-shaped evidence is ELIGIBLE for both classifiers, and grants nothing', async () => {
    const e = await acquire();
    expect(e.complete).toBe(true); expect(e.contradictions).toEqual([]); expect(e.schemaDrift).toEqual([]);
    const r = classifyBundle(ctx(), e, binding, rdCtx());
    expect(r.origin).toBe('MOCK_FIXTURE');
    expect(r.settlement).toMatchObject({ verdict: 'ELIGIBLE', reasonCodes: ['ALL_CONDITIONS_VERIFIED'], grantsFinancialAuthority: false, reservationHeld: true });
    expect(r.refundDispute).toMatchObject({ classification: 'NO_REFUND', grantsFinancialAuthority: false });
    expect(r.settlementEvidence?.provenance.evidenceKind).toBe('MOCK_SYNTHETIC');
    expect(r.settlementEvidence?.settlement).toEqual({ source: 'stripe_payment', paymentRef: 'pi_1' });
    expect(r.settlementEvidence?.lines.complete).toBe(true);
  });

  it('26. negative mock classification: every contradiction we can express keeps the verdict out of ELIGIBLE', async () => {
    const cases: Array<[string, Partial<ExtendedMockInput>, Fx]> = [
      ['payment amount mismatch', {}, { payments: onePage([pay({ amount_paid: 2600 })]) }],
      ['duplicate payment reference', {}, { payments: onePage([pay(), pay({ id: 'inpay_2' })]) }],
      ['line currency', {}, { lines: onePage([baseLines()[0], line('il_ben', -300, itemParent(), { currency: 'eur' })]) }],
      ['fabricated benefit line', { idempotency: [{ parentItemRef: 'ii_ben', idempotencyKey: 'benefit-apply:v1:res-OTHER' }] }, {}],
      ['unproven benefit line', { idempotency: null }, {}],
      ['paid with remaining', { invoiceBefore: invoice({ amount_remaining: 100 }) }, {}],
      ['paid without paid time', { invoiceBefore: invoice({ status_transitions: { paid_at: null, voided_at: null } }) }, {}],
      ['unstable reads', { invoiceAfter: invoice({ amount_due: 2800, amount_paid: 2800 }) }, {}],
      ['refund for another payment', {}, { refunds: onePage([refund({ payment_intent: 'pi_other' })]) }],
      ['overlap', {}, { refunds: onePage([refund()]), disputes: onePage([dispute({ status: 'lost' })]) }],
    ];
    for (const [label, over, fx] of cases) {
      const r = await classify(over, fx);
      notEligible(r, label);
      expect((await acquire(over, fx)).complete, label).toBe(false);
    }
  });

  it('24. evidence origin substitution is refused: clones, serialized copies, edited origins, edited contract versions and non-objects are never trusted', async () => {
    const m = await acquire();
    const real = ((await adapterOver({ transport: new ScriptedReadTransport([{ object: 'account', id: ACCT }, invoice()]), gate: gateFor(AUTH), expectedAccountId: ACCT, clock: () => NOW, audit: () => undefined }).acquire(scope)) as any).evidence;
    expect(sealedOriginOf(m)).toBe('MOCK_FIXTURE'); expect(sealedOriginOf(real)).toBe('STRIPE_TEST_READ');
    for (const forged of [JSON.parse(JSON.stringify(m)), structuredClone(m), { ...m }, { ...m, origin: 'STRIPE_TEST_READ' }, { ...m, origin: null }, { ...m, contractVersion: 'S08-STRIPE-EVIDENCE/0' }, { ...real, origin: 'MOCK_FIXTURE' },
      JSON.parse(JSON.stringify(real)), Object.create(m), null, undefined, 'x', 5, []]) {
      const r = classifyBundle(ctx(), forged as any, binding, rdCtx());
      expect(r.origin).toBe('UNSEALED'); expect(r.settlementEvidence).toBeNull();
      expect(r.settlement.verdict).toBe('UNRESOLVED'); expect(r.settlement.reasonCodes).toEqual(['EVIDENCE_KIND_UNSUPPORTED']);
    }
    expect(() => { (m as any).complete = false; }).toThrow(); // sealed bundles are frozen
    expect(Object.isFrozen(m.invoice) || Object.isFrozen(m)).toBe(true);
  });

  it('27. repeated normalization is stable: identical input gives identical evidence and digest, independent of observation time and key order; any change changes the digest', async () => {
    const a = await acquire(); const b = await acquire(); const c = await acquire({ observedAtMs: NOW - 500 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(c.digest).toBe(a.digest); expect(c.observedAtMs).not.toBe(a.observedAtMs);
    const reordered = Object.fromEntries(Object.entries(invoice()).reverse());
    expect((await acquire({ invoiceBefore: reordered })).digest).toBe(a.digest);
    expect((await acquire({}, { payments: onePage([pay({ amount_paid: 2700, id: 'inpay_1' })].map(p => Object.fromEntries(Object.entries(p).reverse()))) })).digest).toBe(a.digest);
    for (const [over, fx] of [[{ cancellation: 'canceled_after_payment' }, {}], [{}, { refunds: onePage([refund()]) }], [{ invoiceBefore: invoice({ currency: 'eur' }) }, {}]] as Array<[Partial<ExtendedMockInput>, Fx]>) expect((await acquire(over, fx)).digest).not.toBe(a.digest);
    for (let i = 0; i < 5; i++) expect((await acquire()).digest).toBe(a.digest);
  });
});

describe('assembly rules', () => {
  it('completeness is computed: schema drift or a cross-category contradiction removes it even when every individual fact is established', async () => {
    const e = await acquire();
    const parts = { origin: 'MOCK_FIXTURE' as const, observedAtMs: e.observedAtMs, requested: e.requested, accountId: e.accountId, mode: e.mode, facts: e.invoice, factsAfter: e.invoice,
      fingerprintBefore: { status: 'paid', dueMinor: 2700, paidMinor: 2700, remainingMinor: 0, totalMinor: 2700, lineCount: 2 }, fingerprintAfter: { status: 'paid', dueMinor: 2700, paidMinor: 2700, remainingMinor: 0, totalMinor: 2700, lineCount: 2 },
      invoiceContradictions: [], lineAttribution: e.lineAttribution, billingInterval: e.billingInterval, benefitItem: e.benefitItem, cancellation: e.cancellation, settlingPayment: e.settlingPayment, refunds: e.refunds, disputes: e.disputes };
    expect((await assembleEvidence(parts)).complete).toBe(true);
    expect((await assembleEvidence({ ...parts, schemaDrift: ['SOMETHING_NEW'] })).complete).toBe(false);
    expect((await assembleEvidence({ ...parts, extraContradictions: ['X'] })).complete).toBe(false);
    expect((await assembleEvidence({ ...parts, invoiceContradictions: ['Y'] })).complete).toBe(false);
    expect((await assembleEvidence({ ...parts, fingerprintAfter: { ...parts.fingerprintAfter, totalMinor: 1 } })).complete).toBe(false);
  });
});

describe('G. capability boundaries and write-path absence', () => {
  it('28. no Stripe write path exists in the Stripe-read tree: no write verbs, no SDK import, no fetch outside the one GET transport, no request bodies', () => {
    const dir = resolve(__dirname);
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files).toContain('transport.ts');
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(/from 'stripe'|require\('stripe'\)|new Stripe\(/.test(text), `${f} imports the Stripe SDK client`).toBe(false);
      expect(/\bfetch\s*\(/.test(text) && f !== 'transport.ts', `${f} calls fetch`).toBe(false);
      expect(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(text), `${f} has a write verb`).toBe(false);
      expect(/\.(post|put|patch|del|delete)\(/.test(text), `${f} calls a write method`).toBe(false);
      expect(/\bbody\s*:/.test(text) && f === 'transport.ts', 'transport sends a body').toBe(false);
      expect(/create\(|refunds\.create|invoices\.(create|update|pay|finalize|void)|paymentIntents\.|subscriptions\.(update|cancel)/.test(text), `${f} names a Stripe write call`).toBe(false);
    }
    const t = createStripeGetTransport({ apiKey: ['rk', 'test', 'SyntheticKeyMaterial0123456789'].join('_'), fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    expect(Object.keys(t).sort()).toEqual(['get', 'keyMode']);
  });

  it('29. the four unapproved real reads stay inaccessible: no authorization enables them, the real transport has no path for them, and a non-mock source is refused', async () => {
    for (const id of ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST']) {
      expect(decideCapability(id, { ...AUTH, methods: [id as any, 'ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] }, NOW)).toEqual({ allowed: false, reason: 'METHOD_NOT_AUTHORIZED' });
      const t = createStripeGetTransport({ apiKey: ['rk', 'test', 'SyntheticKeyMaterial0123456789'].join('_'), fetchImpl: (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch });
      await expect(t.get(id as any, { invoiceId: 'in_1' })).rejects.toMatchObject({ failureClass: 'DENIED' });
    }
    const real = { sourceKind: 'STRIPE_TEST_READ', listInvoiceLines: async () => { throw new Error('read'); }, listInvoicePayments: async () => { throw new Error('read'); }, listRefunds: async () => { throw new Error('read'); }, listDisputes: async () => { throw new Error('read'); } };
    for (const source of [real, null, undefined, {}, { sourceKind: 'MOCK_FIXTURE ' }, createStripeGetTransport({ apiKey: ['rk', 'test', 'SyntheticKeyMaterial0123456789'].join('_'), fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch })] as any[])
      expect(await acquireMockExtendedEvidence(input({ source }))).toEqual({ ok: false, denied: 'METHOD_NOT_AUTHORIZED' });
    const proto = Object.getOwnPropertyNames(StripeReadOnlyEvidenceAdapter.prototype);
    expect(proto.filter(n => /lines|payment|refund|dispute/i.test(n))).toEqual([]);
  });

  it('30. real provider evidence cannot authorize consumption: it is incomplete by construction, is not converted for the classifiers, and the classifiers answer UNRESOLVED / EVIDENCE_KIND_UNSUPPORTED', async () => {
    const out = await adapterOver({ transport: new ScriptedReadTransport([{ object: 'account', id: ACCT }, invoice()]), gate: gateFor(AUTH), expectedAccountId: ACCT, clock: () => NOW, audit: () => undefined }).acquire(scope);
    if (!out.ok) throw new Error('expected evidence');
    expect(out.evidence.origin).toBe('STRIPE_TEST_READ'); expect(out.evidence.complete).toBe(false);
    for (const f of [out.evidence.settlingPayment, out.evidence.refunds, out.evidence.disputes, out.evidence.lineAttribution]) expect(f.state).toBe('UNRESOLVED');
    const r = classifyBundle(ctx(), out.evidence, binding, rdCtx());
    expect(r).toMatchObject({ origin: 'STRIPE_TEST_READ', settlementEvidence: null, refundDispute: null });
    expect(r.settlement).toMatchObject({ verdict: 'UNRESOLVED', reasonCodes: ['EVIDENCE_KIND_UNSUPPORTED'], grantsFinancialAuthority: false });
    // even a real bundle that somehow claimed completeness would not be converted: the seal, not the data, decides
    expect(classifyBundle(ctx(), { ...out.evidence, complete: true } as any, binding, rdCtx()).settlementEvidence).toBeNull();
  });
});
