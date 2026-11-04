/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifySettlement, benefitIdempotencyKey, MOCK_EVIDENCE_KIND, SETTLEMENT_CLASSIFIER_VERSION, SUPPORTED_ALLOCATION_POLICY_VERSION, SUPPORTED_BENEFIT_POLICY_VERSION,
  type SettlementClassifierContext, type MockSettlementEvidence,
} from './settlement-eligibility.classifier';
import { AGGREGATE_ALLOCATION_POLICY } from './aggregate-benefit-allocation';
import { INVOICE_BENEFIT_POLICY_V1 } from './invoice-benefit.calculator';

/**
 * S08-D1D3-DEV-01 acceptance tests. SYNTHETIC mock evidence only: no provider, no database, no clock. The numeric values (including the freshness window used in
 * fixtures) are TEST FIXTURES, not policy: the owner has not decided the freshness window (OQ-7) and the classifier has no default for it.
 */
const NOW = 10_000_000;
const KEY = benefitIdempotencyKey('res-1');
const D = (c: string) => c.repeat(64).slice(0, 64);

function build(mutate?: (ctx: any, ev: any) => void): [SettlementClassifierContext, MockSettlementEvidence] {
  const lines = [
    { lineRef: 'il_base', amountMinor: 3000, currency: 'usd', category: 'recurring_base', parentItemRef: null, parentItemKey: null, labelReservationRef: null },
    { lineRef: 'il_ben', amountMinor: -300, currency: 'usd', category: 'benefit', parentItemRef: 'ii_ben', parentItemKey: KEY, labelReservationRef: 'res-1' },
  ];
  const fp = { status: 'paid', amountDueMinor: 2700, amountPaidMinor: 2700, amountRemainingMinor: 0, totalMinor: 2700, lineCount: 2 };
  const ctx: any = {
    nowMs: NOW,
    policy: { version: 'PC-BENEFIT/1', effectiveFromMs: 1_000, freshnessWindowMs: 60_000 },
    expected: {
      businessId: 'biz-1', reservationId: 'res-1', intentRef: 'intent-1', invoiceRef: 'in_1', customerRef: 'cus_1', subscriptionRef: 'sub_1', currency: 'usd',
      providerAccountId: 'acct_1', providerMode: 'test', reservationExpiresAtMs: 9_500_000,
      frozenAllocation: {
        artifactVersion: 1, allocationPolicyVersion: 'S08-AGG-ROUND/1', benefitPolicyVersion: 'PC-BENEFIT/1', businessId: 'biz-1', invoiceRef: 'in_1', currency: 'usd',
        eligibleBaseMinor: 3000, eligibleCreditBalance: 1, unitsToApply: 1, aggregateBenefitMinor: 300, percentApplied: 10,
        allocations: [{ reservationId: 'res-1', invoiceIntentRef: 'intent-1', units: 1, benefitMinor: 300, providerIdempotencyKey: KEY }],
        allocationDigest: D('a'), providerVerified: false, consumptionAuthorized: false,
      },
    },
  };
  const ev: any = {
    provenance: { evidenceKind: MOCK_EVIDENCE_KIND, snapshotRef: 'snap_1', snapshotDigest: D('b'), observedAtMs: NOW - 1_000, providerOutcome: 'ok', complete: true, readBefore: { ...fp }, readAfter: { ...fp } },
    binding: { businessId: 'biz-1', reservationId: 'res-1', intentRef: 'intent-1' },
    provider: { accountId: 'acct_1', mode: 'test' },
    invoice: { id: 'in_1', customerRef: 'cus_1', subscriptionRef: 'sub_1', currency: 'usd', status: 'paid', amountDueMinor: 2700, amountPaidMinor: 2700, amountRemainingMinor: 0, totalMinor: 2700,
      createdAtMs: 5_000, paidAtMs: 9_000_000, voidedAtMs: null, billingInterval: 'month' },
    lines: { complete: true, items: lines },
    benefitItem: { itemRef: 'ii_ben', invoiceRef: 'in_1', idempotencyKey: KEY, amountMinor: -300, currency: 'usd', discountable: false },
    settlement: { source: 'stripe_payment', paymentRef: 'pi_1' },
    events: { refund: 'none', dispute: 'none', cancellation: 'none' },
  };
  mutate?.(ctx, ev);
  return [ctx, ev];
}
/** Re-derive the bracketing fingerprints and totals from the (possibly mutated) invoice so a test changes one fact at a time. */
function sync(ev: any) {
  const i = ev.invoice;
  const fp = { status: i.status, amountDueMinor: i.amountDueMinor, amountPaidMinor: i.amountPaidMinor, amountRemainingMinor: i.amountRemainingMinor, totalMinor: i.totalMinor, lineCount: ev.lines.items.length };
  ev.provenance.readBefore = { ...fp }; ev.provenance.readAfter = { ...fp };
}
function setTotal(ev: any, total: number) { ev.invoice.totalMinor = total; ev.invoice.amountDueMinor = total; ev.invoice.amountPaidMinor = total; ev.invoice.amountRemainingMinor = 0; sync(ev); }
const run = (m?: (c: any, e: any) => void) => { const [c, e] = build(m); return classifySettlement(c, e); };
const expectU = (r: ReturnType<typeof run>, ...codes: string[]) => { expect(r.verdict).toBe('UNRESOLVED'); expect(r.reasonCodes).toEqual(expect.arrayContaining(codes)); };
const expectI = (r: ReturnType<typeof run>, ...codes: string[]) => { expect(r.verdict).toBe('INELIGIBLE'); expect(r.reasonCodes).toEqual(codes); };

describe('S08-D1D3-DEV-01 mock settlement eligibility classifier', () => {
  describe('ELIGIBLE (classification only)', () => {
    it('1. a fully paid, independently verified invoice is ELIGIBLE and grants no authority', () => {
      const r = run();
      expect(r).toMatchObject({ verdict: 'ELIGIBLE', reasonCodes: ['ALL_CONDITIONS_VERIFIED'], unresolvedRequirements: [], manualReviewRequired: false, reservationHeld: true,
        grantsFinancialAuthority: false, classifierVersion: SETTLEMENT_CLASSIFIER_VERSION, policyVersion: 'PC-BENEFIT/1', evaluatedAt: new Date(NOW).toISOString() });
      expect(r.evidenceRefs).toEqual({ snapshotRef: 'snap_1', snapshotDigest: D('b'), invoiceRef: 'in_1', benefitItemRef: 'ii_ben', paymentRef: 'pi_1', allocationDigest: D('a') });
    });
    it('4. a zero-total invoice with positive pre-benefit value is ELIGIBLE', () => {
      const r = run((_, e) => { e.lines.items.splice(1, 0, { lineRef: 'il_credit', amountMinor: -2700, currency: 'usd', category: 'other', parentItemRef: null, parentItemKey: null, labelReservationRef: null }); setTotal(e, 0); });
      expect(r.verdict).toBe('ELIGIBLE');
    });
    it('23. an annual invoice with eligible lines is classified like any other; the interval is advisory only (frozen at allocation, not re-evaluated)', () => {
      const r = run((_, e) => { e.invoice.billingInterval = 'year'; });
      expect(r).toMatchObject({ verdict: 'ELIGIBLE', advisories: ['INTERVAL_FROZEN_NOT_REEVALUATED'] });
    });
    it('24b. proration lines are excluded from the eligible base: extra proration with an unchanged recurring base stays ELIGIBLE', () => {
      const r = run((_, e) => { e.lines.items.push({ lineRef: 'il_pro', amountMinor: 500, currency: 'usd', category: 'proration', parentItemRef: null, parentItemKey: null, labelReservationRef: null }); setTotal(e, 3200); });
      expect(r.verdict).toBe('ELIGIBLE');
    });
    it('multiple credits on one invoice: another reservation\'s allocated benefit line is accepted, within the frozen aggregate', () => {
      const other = benefitIdempotencyKey('res-2');
      const r = run((c, e) => {
        c.expected.frozenAllocation.allocations.push({ reservationId: 'res-2', invoiceIntentRef: 'intent-2', units: 1, benefitMinor: 300, providerIdempotencyKey: other });
        c.expected.frozenAllocation.aggregateBenefitMinor = 600;
        e.lines.items.push({ lineRef: 'il_ben2', amountMinor: -300, currency: 'usd', category: 'benefit', parentItemRef: 'ii_ben2', parentItemKey: other, labelReservationRef: null }); setTotal(e, 2400);
      });
      expect(r.verdict).toBe('ELIGIBLE');
    });
    it('a won dispute with no other loss does not block', () => { expect(run((_, e) => { e.events.dispute = 'won'; }).verdict).toBe('ELIGIBLE'); });
  });

  describe('settlement state', () => {
    it('2. paid with a non-zero amount remaining is UNRESOLVED', () => {
      expectU(run((_, e) => { e.invoice.amountPaidMinor = 2600; e.invoice.amountRemainingMinor = 100; sync(e); }), 'PAID_WITH_REMAINING');
    });
    it('3. a partial payment is UNRESOLVED (held for reconciliation)', () => {
      const r = run((_, e) => { e.invoice.status = 'open'; e.invoice.amountPaidMinor = 1000; e.invoice.amountRemainingMinor = 1700; e.invoice.paidAtMs = null; sync(e); });
      expectU(r, 'PARTIAL_PAYMENT'); expect(r.unresolvedRequirements).toContain('full payment');
    });
    it('open and draft invoices are not settled', () => {
      for (const status of ['open', 'draft']) expectU(run((_, e) => { e.invoice.status = status; e.invoice.amountPaidMinor = 0; e.invoice.amountRemainingMinor = 2700; e.invoice.paidAtMs = null; sync(e); }), 'NOT_SETTLED');
    });
    it('an unknown invoice status is UNRESOLVED, never eligible', () => { expectU(run((_, e) => { e.invoice.status = 'mystery'; sync(e); }), 'STATUS_UNKNOWN'); });
    it('5. a zero-total invoice with zero pre-benefit value is INELIGIBLE (no economic benefit)', () => {
      const r = run((_, e) => { e.lines.items = [e.lines.items[0], { lineRef: 'il_offset', amountMinor: -3000, currency: 'usd', category: 'other', parentItemRef: null, parentItemKey: null, labelReservationRef: null }]; e.benefitItem = null; setTotal(e, 0); });
      expectI(r, 'NO_ECONOMIC_BENEFIT'); expect(r.manualReviewRequired).toBe(true);
    });
    it('17. an invoice voided before payment is INELIGIBLE as of the snapshot', () => {
      const r = run((_, e) => { e.invoice.status = 'void'; e.invoice.amountPaidMinor = 0; e.invoice.amountRemainingMinor = 2700; e.invoice.paidAtMs = null; e.invoice.voidedAtMs = 8_000_000; sync(e); });
      expectI(r, 'INVOICE_VOID');
    });
    it('18. an uncollectible invoice is INELIGIBLE and needs manual review before any release', () => {
      const r = run((_, e) => { e.invoice.status = 'uncollectible'; e.invoice.amountPaidMinor = 0; e.invoice.amountRemainingMinor = 2700; e.invoice.paidAtMs = null; sync(e); });
      expectI(r, 'INVOICE_UNCOLLECTIBLE'); expect(r.manualReviewRequired).toBe(true);
    });
    it('19. out-of-band settlement is INELIGIBLE; an unknown or malformed settlement source is UNRESOLVED', () => {
      expectI(run((_, e) => { e.settlement.source = 'out_of_band'; }), 'OUT_OF_BAND');
      expectU(run((_, e) => { e.settlement.source = 'unknown'; }), 'SETTLEMENT_SOURCE_UNKNOWN');
      expectU(run((_, e) => { e.settlement.paymentRef = null; }), 'SETTLEMENT_SOURCE_UNKNOWN');
      expectU(run((_, e) => { e.settlement.source = 'wire'; }), 'SETTLEMENT_SOURCE_UNKNOWN');
    });
    it('a settlement time is required; a paid invoice without one is UNRESOLVED', () => { expectU(run((_, e) => { e.invoice.paidAtMs = null; }), 'SETTLEMENT_TIME_MISSING'); });
  });

  describe('benefit line, amount, currency and attribution', () => {
    it('6. an invoice without the expected benefit line is UNRESOLVED', () => {
      const r = run((_, e) => { e.lines.items = [e.lines.items[0]]; e.benefitItem = null; setTotal(e, 3000); });
      expectU(r, 'BENEFIT_LINE_MISSING');
    });
    it('7. a wrong benefit amount (above and below the frozen amount) is UNRESOLVED', () => {
      for (const amt of [-299, -301]) expectU(run((_, e) => { e.benefitItem.amountMinor = amt; e.lines.items[1].amountMinor = amt; setTotal(e, 3000 + amt); }), 'AMOUNT_MISMATCH');
    });
    it('8. a wrong currency is UNRESOLVED (invoice, item and line)', () => {
      expectU(run((_, e) => { e.invoice.currency = 'eur'; }), 'CURRENCY_MISMATCH');
      expectU(run((_, e) => { e.benefitItem.currency = 'eur'; }), 'CURRENCY_MISMATCH');
      expectU(run((_, e) => { e.lines.items[1].currency = 'eur'; }), 'CURRENCY_MISMATCH');
    });
    it('9. a wrong reservation is UNRESOLVED (binding, intent and a foreign benefit key)', () => {
      expectU(run((_, e) => { e.binding.reservationId = 'res-9'; }), 'RESERVATION_MISMATCH');
      expectU(run((_, e) => { e.binding.intentRef = 'intent-9'; }), 'RESERVATION_MISMATCH');
      expectU(run((_, e) => { e.lines.items[1].parentItemKey = benefitIdempotencyKey('res-9'); }), 'UNEXPECTED_BENEFIT_LINE');
    });
    it('29. a tampered item-to-line correlation is UNRESOLVED; a metadata label alone never attributes', () => {
      expectU(run((_, e) => { e.lines.items[1].parentItemRef = 'ii_other'; }), 'ATTRIBUTION_MISMATCH');
      expectU(run((_, e) => { e.lines.items[1].parentItemRef = null; }), 'ATTRIBUTION_MISMATCH');
      expectU(run((_, e) => { e.benefitItem.invoiceRef = 'in_other'; }), 'ATTRIBUTION_MISMATCH');
      expectU(run((_, e) => { e.benefitItem.idempotencyKey = benefitIdempotencyKey('res-2'); }), 'ATTRIBUTION_MISMATCH');
    });
    it('a discountable benefit item violates D1-b and is UNRESOLVED', () => { expectU(run((_, e) => { e.benefitItem.discountable = true; }), 'BENEFIT_DISCOUNTABLE'); });
    it('21. two benefit lines for one reservation are a duplicate effect; an unallocated or over-cap benefit line is unexpected', () => {
      expectU(run((_, e) => { e.lines.items.push({ ...e.lines.items[1], lineRef: 'il_ben_dup' }); setTotal(e, 2400); }), 'DUPLICATE_EFFECT');
      expectU(run((_, e) => { e.lines.items.push({ lineRef: 'il_x', amountMinor: -50, currency: 'usd', category: 'benefit', parentItemRef: 'ii_x', parentItemKey: 'benefit-apply:v1:res-7', labelReservationRef: null }); setTotal(e, 2650); }), 'UNEXPECTED_BENEFIT_LINE');
    });
    it('21b. a negative invoice total is never accepted (D1-b)', () => { expectU(run((_, e) => { e.invoice.totalMinor = -10; sync(e); }), 'AMOUNTS_INCONSISTENT'); });
    it('24. proration-only base is ambiguous and UNRESOLVED; a base that differs from the frozen base is drift', () => {
      expectU(run((_, e) => { e.lines.items[0] = { ...e.lines.items[0], category: 'proration' }; }), 'PRORATION_ONLY_BASE');
      const drift = run((_, e) => { e.lines.items[0].amountMinor = 3100; setTotal(e, 2800); });
      expectU(drift, 'EVIDENCE_DRIFT'); expect(drift.manualReviewRequired).toBe(true);
    });
    it('duplicate invoice line references and inconsistent arithmetic are UNRESOLVED', () => {
      expectU(run((_, e) => { e.lines.items[1].lineRef = 'il_base'; }), 'DUPLICATE_LINE');
      expectU(run((_, e) => { e.invoice.amountDueMinor = 2800; sync(e); }), 'AMOUNTS_INCONSISTENT');
      expectU(run((_, e) => { e.invoice.totalMinor = 2699; sync(e); }), 'AMOUNTS_INCONSISTENT');
    });
  });

  describe('scope: tenant, account, mode, invoice', () => {
    it('10. a wrong tenant is UNRESOLVED with manual review', () => { const r = run((_, e) => { e.binding.businessId = 'biz-2'; }); expectU(r, 'TENANT_MISMATCH'); expect(r.manualReviewRequired).toBe(true); });
    it('11. a wrong Stripe account is UNRESOLVED', () => { const r = run((_, e) => { e.provider.accountId = 'acct_other'; }); expectU(r, 'SCOPE_MISMATCH'); expect(r.manualReviewRequired).toBe(true); });
    it('12. a wrong Stripe mode is UNRESOLVED in both directions', () => {
      expectU(run((_, e) => { e.provider.mode = 'live'; }), 'SCOPE_MISMATCH');
      expectU(run((c, _) => { c.expected.providerMode = 'live'; }), 'SCOPE_MISMATCH');
    });
    it('invoice, customer and subscription identity must equal the persisted binding', () => {
      for (const k of ['id', 'customerRef', 'subscriptionRef']) expectU(run((_, e) => { e.invoice[k] = 'x_other'; }), 'SCOPE_MISMATCH');
    });
    it('a frozen allocation for another business, invoice, currency or policy is rejected', () => {
      for (const f of [(a: any) => { a.businessId = 'biz-2'; }, (a: any) => { a.invoiceRef = 'in_2'; }, (a: any) => { a.currency = 'eur'; }, (a: any) => { a.allocationPolicyVersion = 'S08-AGG-ROUND/2'; },
        (a: any) => { a.aggregateBenefitMinor = 301; }, (a: any) => { a.allocations[0].providerIdempotencyKey = 'benefit-apply:v1:other'; }, (a: any) => { a.allocations = []; }])
        expectU(run(c => f(c.expected.frozenAllocation)), 'FROZEN_ALLOCATION_MISMATCH');
    });
  });

  describe('provider, completeness, stability, freshness', () => {
    it('16. a provider that was unreachable, rate limited or failed is UNRESOLVED', () => {
      for (const o of ['unreachable', 'rate_limited', 'permanent_error']) expectU(run((_, e) => { e.provenance.providerOutcome = o; }), 'PROVIDER_UNREACHABLE');
    });
    it('truncated or incomplete evidence is UNRESOLVED', () => {
      expectU(run((_, e) => { e.lines.complete = false; }), 'INCOMPLETE_EVIDENCE');
      expectU(run((_, e) => { e.provenance.complete = false; }), 'INCOMPLETE_EVIDENCE');
      expectU(run((_, e) => { e.provenance.readAfter = null; }), 'INCOMPLETE_EVIDENCE');
    });
    it('20. payment status changing during observation is UNRESOLVED (unstable)', () => {
      expectU(run((_, e) => { e.provenance.readAfter = { ...e.provenance.readAfter, status: 'open' }; }), 'EVIDENCE_UNSTABLE');
      expectU(run((_, e) => { e.provenance.readAfter = { ...e.provenance.readAfter, amountPaidMinor: 2000, amountRemainingMinor: 700 }; }), 'EVIDENCE_UNSTABLE');
      expectU(run((_, e) => { e.provenance.readAfter = { ...e.provenance.readAfter, lineCount: 3 }; }), 'EVIDENCE_UNSTABLE');
      expectU(run((_, e) => { e.provenance.readBefore = { ...e.provenance.readBefore, status: 'open' }; e.provenance.readAfter = { ...e.provenance.readBefore }; }), 'EVIDENCE_UNSTABLE'); // reads agree with each other but not with the evaluated invoice
    });
    it('13. stale evidence is UNRESOLVED; exactly the window is still fresh; future-dated evidence is refused', () => {
      expectU(run((_, e) => { e.provenance.observedAtMs = NOW - 60_001; }), 'STALE_EVIDENCE');
      expect(run((_, e) => { e.provenance.observedAtMs = NOW - 60_000; }).verdict).toBe('ELIGIBLE');
      expectU(run((_, e) => { e.provenance.observedAtMs = NOW + 1; }), 'EVIDENCE_FROM_FUTURE');
    });
    it('the freshness window is an explicit policy dependency: absent, null or invalid means the classifier can never return ELIGIBLE (no hardcoded window)', () => {
      for (const w of [null, undefined, -1, 1.5, Number.NaN, '60000']) {
        const r = run(c => { c.policy.freshnessWindowMs = w; });
        expectU(r, 'FRESHNESS_POLICY_UNAVAILABLE'); expect(r.unresolvedRequirements).toContain('an owner-approved freshness window (OQ-7)');
      }
      expect(run(c => { delete c.policy.freshnessWindowMs; }).verdict).toBe('UNRESOLVED');
    });
    it('22. the reservation expiry boundary: settlement strictly before expiry only (expired when expires_at <= now, the reservation convention)', () => {
      expect(run(c => { c.expected.reservationExpiresAtMs = 9_000_001; }).verdict).toBe('ELIGIBLE');
      const at = run(c => { c.expected.reservationExpiresAtMs = 9_000_000; }); expectU(at, 'SETTLED_AFTER_EXPIRY'); expect(at.manualReviewRequired).toBe(true);
      expectU(run(c => { c.expected.reservationExpiresAtMs = 8_999_999; }), 'SETTLED_AFTER_EXPIRY');
      expectU(run(c => { c.expected.reservationExpiresAtMs = null; }), 'RESERVATION_EXPIRY_UNKNOWN');
    });
  });

  describe('contradictory refund, dispute and cancellation evidence', () => {
    it('15. contradictory evidence is UNRESOLVED', () => {
      expectU(run((_, e) => { e.invoice.status = 'void'; e.invoice.paidAtMs = 9_000_000; sync(e); }), 'CONTRADICTORY_EVIDENCE');
      expectU(run((_, e) => { e.invoice.voidedAtMs = 8_000_000; }), 'CONTRADICTORY_EVIDENCE');
      expectU(run((_, e) => { e.events.cancellation = 'canceled_before_payment'; }), 'CONTRADICTORY_EVIDENCE');
      expect(run((_, e) => { e.events.cancellation = 'canceled_after_payment'; }).verdict).toBe('ELIGIBLE');
    });
    it('25. an open payment dispute is UNRESOLVED; a lost one is INELIGIBLE; unknown dispute evidence is UNRESOLVED', () => {
      expectU(run((_, e) => { e.events.dispute = 'open'; }), 'DISPUTE_OPEN');
      expectI(run((_, e) => { e.events.dispute = 'lost'; }), 'PAYMENT_DISPUTE_LOST');
      expectU(run((_, e) => { e.events.dispute = 'unknown'; }), 'DISPUTE_EVIDENCE_UNKNOWN');
      expectU(run((_, e) => { e.events.dispute = 'chargeback'; }), 'DISPUTE_EVIDENCE_UNKNOWN');
    });
    it('26. refund evidence after payment: pending and partial hold (UNRESOLVED); full is INELIGIBLE; unknown is UNRESOLVED', () => {
      expectU(run((_, e) => { e.events.refund = 'pending'; }), 'REFUND_PENDING');
      const p = run((_, e) => { e.events.refund = 'partial'; }); expectU(p, 'REFUND_PARTIAL'); expect(p.manualReviewRequired).toBe(true);
      expectI(run((_, e) => { e.events.refund = 'full'; }), 'REFUNDED');
      expectU(run((_, e) => { e.events.refund = 'unknown'; }), 'REFUND_EVIDENCE_UNKNOWN');
      expectU(run((_, e) => { e.events.cancellation = 'unknown'; }), 'CANCELLATION_EVIDENCE_UNKNOWN');
    });
    it('an open dispute dominates a full refund (precedence: unresolved holds before disqualification)', () => {
      expectU(run((_, e) => { e.events.dispute = 'open'; e.events.refund = 'full'; }), 'DISPUTE_OPEN');
    });
  });

  describe('policy', () => {
    it('27. a missing or different policy version is UNRESOLVED', () => {
      for (const v of [null, '']) expectU(run(c => { c.policy.version = v; }), 'POLICY_VERSION_MISSING');
      expectU(run(c => { c.expected.frozenAllocation.benefitPolicyVersion = ''; }), 'POLICY_VERSION_MISSING');
      expectU(run(c => { c.policy.version = 'PC-BENEFIT/2'; c.expected.frozenAllocation.benefitPolicyVersion = 'PC-BENEFIT/2'; }), 'POLICY_VERSION_MISMATCH');
      expectU(run(c => { c.expected.frozenAllocation.benefitPolicyVersion = 'PC-BENEFIT/2'; }), 'POLICY_VERSION_MISMATCH');
    });
    it('28. an invoice created before the policy effective instant is INELIGIBLE (prospective only); a missing instant is UNRESOLVED; the boundary instant itself applies', () => {
      expectI(run((_, e) => { e.invoice.createdAtMs = 999; }), 'POLICY_NOT_EFFECTIVE');
      expect(run((_, e) => { e.invoice.createdAtMs = 1_000; }).verdict).toBe('ELIGIBLE');
      for (const t of [null, -1, Number.NaN]) expectU(run(c => { c.policy.effectiveFromMs = t; }), 'POLICY_EFFECTIVE_DATE_UNAVAILABLE');
    });
    it('the supported policy constants equal the real ones (drift guard)', () => {
      expect(SUPPORTED_BENEFIT_POLICY_VERSION).toBe(INVOICE_BENEFIT_POLICY_V1.version);
      expect(SUPPORTED_ALLOCATION_POLICY_VERSION).toBe(AGGREGATE_ALLOCATION_POLICY);
    });
  });

  describe('missing, malformed and unsupported evidence', () => {
    it('14. missing evidence is UNRESOLVED and never throws', () => {
      for (const ev of [null, undefined]) expect(classifySettlement(build()[0], ev as any)).toMatchObject({ verdict: 'UNRESOLVED', reasonCodes: ['EVIDENCE_MISSING'] });
      for (const k of ['provenance', 'binding', 'provider', 'invoice', 'lines', 'settlement', 'events']) expectU(run((_, e) => { delete e[k]; }), 'EVIDENCE_MISSING');
      expectU(run((_, e) => { e.lines.items = 'not-an-array'; }), 'EVIDENCE_MISSING');
    });
    it('malformed context and garbage input fail closed without throwing or leaking text', () => {
      const [c, e] = build();
      for (const bad of [null, undefined, {}, { nowMs: 1 }, { ...c, nowMs: 'x' }, { ...c, expected: null }]) expect(classifySettlement(bad as any, e).verdict).toBe('UNRESOLVED');
      for (const bad of [{}, { provenance: {} }, 42, 'x', [], { ...e, provenance: { ...e.provenance, snapshotDigest: 'short' } }]) expect(classifySettlement(c, bad as any).verdict).toBe('UNRESOLVED');
      const weird = run((_, ev) => { ev.invoice.totalMinor = Number.NaN; });
      expect(weird.verdict).toBe('UNRESOLVED');
    });
    it('only the mock evidence kind is accepted: a real-looking verified envelope is refused until it is specified', () => {
      for (const k of ['STRIPE_VERIFIED', 'LIVE', '', undefined]) expectU(run((_, e) => { e.provenance.evidenceKind = k; }), 'EVIDENCE_KIND_UNSUPPORTED');
    });
  });

  describe('adversarial: caller-controlled fields cannot manufacture settlement authority', () => {
    it('any asserted authority key anywhere in the evidence or context is refused', () => {
      const attacks: Array<(c: any, e: any) => void> = [
        (_, e) => { e.consumptionAuthorized = true; }, (_, e) => { e.invoice.verified = true; }, (_, e) => { e.lines.items[1].authorized = true; },
        (_, e) => { e.settlement.eligible = 'yes'; }, (_, e) => { e.provenance.trusted = 1; }, (_, e) => { e.benefitItem.approved = true; },
        (_, e) => { e.events.settlementAuthorized = true; }, (_, e) => { e.provenance.financialAuthority = { granted: true }; },
        (c, _) => { c.expected.frozenAllocation.providerVerified = true; }, (c, _) => { c.expected.frozenAllocation.consumptionAuthorized = true; }, (c, _) => { c.policy.authorized = true; },
      ];
      for (const a of attacks) { const r = run(a); expectU(r, 'CALLER_AUTHORITY_ASSERTED'); expect(r.manualReviewRequired).toBe(true); expect(r.grantsFinancialAuthority).toBe(false); }
    });
    it('the legitimate literal false flags on the frozen allocation are not an assertion', () => { expect(run().verdict).toBe('ELIGIBLE'); });
    it('a webhook-style assertion ("paid") without matching independent facts cannot make the invoice eligible', () => {
      expectU(run((_, e) => { e.invoice.status = 'paid'; e.invoice.amountRemainingMinor = 2700; e.invoice.amountPaidMinor = 0; sync(e); }), 'PAID_WITH_REMAINING');
      expectU(run((_, e) => { e.provenance.providerOutcome = 'unreachable'; e.invoice.status = 'paid'; }), 'PROVIDER_UNREACHABLE');
    });
    it('provider text and secrets in unknown fields are never echoed; refs are restricted to safe identifiers', () => {
      const [c, e] = build((_, ev) => { ev.rawPayload = 'sk_live_SECRET_VALUE'; ev.invoice.hostedUrl = 'https://x/secret'; ev.provenance.snapshotRef = 'snap with spaces & <script>'; ev.settlement.paymentRef = 'pi_ok'; });
      const r = classifySettlement(c, e);
      const json = JSON.stringify(r);
      expect(json).not.toMatch(/sk_live|SECRET|hostedUrl|script|spaces/);
      expect(r.evidenceRefs.snapshotRef).toBeNull();
      expect(r.evidenceRefs.paymentRef).toBe('pi_ok');
    });
    it('cross-tenant and cross-mode evidence is never eligible even if every other fact is perfect', () => {
      expect(run((_, e) => { e.binding.businessId = 'biz-2'; }).verdict).toBe('UNRESOLVED');
      expect(run((_, e) => { e.provider.mode = 'live'; }).verdict).toBe('UNRESOLVED');
    });
  });

  describe('determinism and purity', () => {
    it('21c/30. replayed or repeated classification of equivalent input is identical and never mutates the input', () => {
      const [c, e] = build();
      const deepFreeze = (o: any): any => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
      const before = JSON.stringify([c, e]);
      deepFreeze(c); deepFreeze(e);
      const a = classifySettlement(c, e); const b = classifySettlement(c, e);
      expect(a).toEqual(b);
      expect(JSON.stringify([c, e])).toBe(before);
      expect(classifySettlement(...build())).toEqual(a);
      const [c2, e2] = build((_, ev) => { ev.events.refund = 'partial'; });
      expect(classifySettlement(c2, e2)).toEqual(classifySettlement(...build((_, ev) => { ev.events.refund = 'partial'; })));
    });
    it('the evaluation timestamp is the injected clock, not the wall clock', () => {
      expect(run(c => { c.nowMs = NOW; }).evaluatedAt).toBe('1970-01-01T02:46:40.000Z');
    });
    it('the module is side-effect free: no I/O, clock, randomness, environment, database or provider import', () => {
      const src = readFileSync(resolve(__dirname, 'settlement-eligibility.classifier.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/Date\.now|new Date\(\)|Math\.random|process\.|fetch\(|crypto|require\(|\bawait\b|\basync\b|setTimeout/);
      const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+'([^']+)'/gm)].map(m => [m[1], m[2]]);
      expect(imports).toEqual([['type ', './aggregate-benefit-allocation']]);
      expect(src).not.toMatch(/\bstripe\b|drizzle|db\/|\.insert\(|\.update\(|\.delete\(/i);
    });
  });
});
