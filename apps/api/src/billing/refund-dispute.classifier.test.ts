/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyRefundDispute, REFUND_DISPUTE_CLASSIFIER_VERSION, EVIDENCE_ORIGIN, type RefundDisputeContext, type MockRefundDisputeEvidence } from './refund-dispute.classifier';
import { MOCK_EVIDENCE_KIND } from './settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-02 tests. SYNTHETIC mock evidence only: no provider, no database, no clock. Numeric values (including the freshness window in fixtures) are TEST FIXTURES,
 * not policy: the owner has not decided the freshness window (OQ-7) and the classifier has no default for it.
 */
const NOW = 10_000_000;
const D = (c: string) => c.repeat(64).slice(0, 64);
const PAID = 10_000;

const refund = (id: string, amountMinor: number, finality: any = 'succeeded', finalizedAtMs: number | null = 9_000_000): any =>
  ({ id, businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', amountMinor, finality, finalizedAtMs });
const dispute = (id: string, amountMinor: number, outcome: any, overlapsRefundIds: string[] | null = null, closedAtMs: number | null = 9_100_000): any =>
  ({ id, businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', amountMinor, outcome, closedAtMs, overlapsRefundIds });

function sync(ev: any) {
  const fp = { paidMinor: ev.payment.paidMinor, refundCount: ev.refunds.items.length, disputeCount: ev.disputes.items.length, contentDigest: D('c') };
  ev.provenance.readBefore = { ...fp }; ev.provenance.readAfter = { ...fp };
}
function build(mutate?: (ctx: any, ev: any) => void): [RefundDisputeContext, MockRefundDisputeEvidence] {
  const ctx: any = {
    nowMs: NOW,
    policy: { version: 'PC-BENEFIT/1', freshnessWindowMs: 60_000 },
    expected: { businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', providerAccountId: 'acct_1', providerMode: 'test', consumedAtMs: 8_000_000 },
  };
  const ev: any = {
    provenance: { evidenceKind: MOCK_EVIDENCE_KIND, origin: EVIDENCE_ORIGIN, snapshotRef: 'snap_1', snapshotDigest: D('b'), observedAtMs: NOW - 1_000, providerOutcome: 'ok', complete: true, readBefore: null, readAfter: null },
    binding: { businessId: 'biz-1' },
    provider: { accountId: 'acct_1', mode: 'test' },
    payment: { ref: 'pi_1', invoiceRef: 'in_1', currency: 'usd', paidMinor: PAID },
    refunds: { complete: true, items: [] },
    disputes: { complete: true, items: [] },
  };
  mutate?.(ctx, ev);
  sync(ev); // re-derive the bracketing reads from the (possibly mutated) lists; tests that need unstable reads edit them afterwards via `after`
  return [ctx, ev];
}
/** Like build, but lets a test edit AFTER the fingerprints were derived (to make reads unstable or counts disagree). */
function buildAfter(post: (ctx: any, ev: any) => void) { const [c, e] = build(); post(c, e); return [c, e] as [RefundDisputeContext, MockRefundDisputeEvidence]; }
const run = (m?: (c: any, e: any) => void) => { const [c, e] = build(m); return classifyRefundDispute(c, e); };
const runAfter = (post: (c: any, e: any) => void) => { const [c, e] = buildAfter(post); return classifyRefundDispute(c, e); };
const withItems = (refunds: any[], disputes: any[] = []) => (_: any, e: any) => { e.refunds.items = refunds; e.disputes.items = disputes; };
const expectClass = (r: ReturnType<typeof run>, cls: string, ...codes: string[]) => { expect(r.classification).toBe(cls); expect(r.reasonCodes).toEqual(expect.arrayContaining(codes)); };

describe('S08-D1D3-DEV-02 mock refund and payment-dispute classifier', () => {
  describe('the nine classes', () => {
    it('1. no refund with complete evidence', () => {
      const r = run();
      expect(r).toMatchObject({ classification: 'NO_REFUND', reasonCodes: ['NO_REFUND_OR_DISPUTE_VERIFIED'], amounts: { paidMinor: PAID, lossMinor: 0, extent: 'none' }, requiresReconciliation: false,
        manualReviewRequired: false, mayQualifyForFutureRecoveryReview: false, grantsFinancialAuthority: false, classifierVersion: REFUND_DISPUTE_CLASSIFIER_VERSION, decisionRecord: 'S08-D1D3/1',
        policyVersion: 'PC-BENEFIT/1', evaluatedAt: new Date(NOW).toISOString(), outstandingUncertainties: [] });
      expect(r.evaluated).toEqual({ businessId: 'biz-1', invoiceRef: 'in_1', paymentRef: 'pi_1', currency: 'usd', providerAccountId: 'acct_1', providerMode: 'test' });
      expect(r.evidenceRefs).toEqual({ snapshotRef: 'snap_1', snapshotDigest: D('b'), refundRefs: [], disputeRefs: [] });
    });
    it('2. a full finalized refund is FULL_REFUND_VERIFIED and may qualify for a future recovery review (evidence statement only)', () => {
      const r = run(withItems([refund('re_1', PAID)]));
      expect(r).toMatchObject({ classification: 'FULL_REFUND_VERIFIED', reasonCodes: ['FULL_REFUND_VERIFIED'], amounts: { lossMinor: PAID, extent: 'full' }, mayQualifyForFutureRecoveryReview: true,
        requiresReconciliation: false, manualReviewRequired: false, grantsFinancialAuthority: false, relativeToConsumption: 'after' });
      expect(r.advisories).toContain('RECOVERY_APPROVAL_MODEL_UNDECIDED');
    });
    it('3. a partial finalized refund is PARTIAL_REFUND_VERIFIED: reconciliation hold, manual review, no recovery eligibility', () => {
      const r = run(withItems([refund('re_1', 4_000)]));
      expect(r).toMatchObject({ classification: 'PARTIAL_REFUND_VERIFIED', amounts: { lossMinor: 4_000, extent: 'partial' }, requiresReconciliation: true, manualReviewRequired: true,
        mayQualifyForFutureRecoveryReview: false });
      expect(r.outstandingUncertainties).toContain('a separate owner-approved partial-refund policy (OQ-11)');
    });
    it('4. a pending refund (pending or requires action) is REFUND_PENDING', () => {
      for (const f of ['pending', 'requires_action']) {
        const r = run(withItems([refund('re_1', PAID, f, null)]));
        expectClass(r, 'REFUND_PENDING', 'REFUND_PENDING'); expect(r).toMatchObject({ requiresReconciliation: true, amounts: { lossMinor: null, extent: 'unknown' }, mayQualifyForFutureRecoveryReview: false });
      }
    });
    it('5. an open dispute is DISPUTE_OPEN, never a final loss', () => {
      const r = run(withItems([], [dispute('dp_1', PAID, 'open', null, null)]));
      expectClass(r, 'DISPUTE_OPEN', 'DISPUTE_OPEN'); expect(r).toMatchObject({ requiresReconciliation: true, manualReviewRequired: true, amounts: { lossMinor: null }, mayQualifyForFutureRecoveryReview: false });
    });
    it('6. a verified lost dispute is DISPUTE_LOST_VERIFIED (not disguised as a refund); full may qualify, partial is held', () => {
      const full = run(withItems([], [dispute('dp_1', PAID, 'lost')]));
      expect(full).toMatchObject({ classification: 'DISPUTE_LOST_VERIFIED', reasonCodes: ['DISPUTE_LOST_VERIFIED'], amounts: { lossMinor: PAID, extent: 'full' }, mayQualifyForFutureRecoveryReview: true, requiresReconciliation: false });
      const part = run(withItems([], [dispute('dp_1', 3_000, 'lost')]));
      expect(part).toMatchObject({ classification: 'DISPUTE_LOST_VERIFIED', reasonCodes: ['PARTIAL_LOSS_VERIFIED'], amounts: { lossMinor: 3_000, extent: 'partial' }, mayQualifyForFutureRecoveryReview: false,
        requiresReconciliation: true, manualReviewRequired: true });
    });
    it('7. a verified won dispute is DISPUTE_WON_VERIFIED and does not itself reverse consumption', () => {
      const r = run(withItems([], [dispute('dp_1', PAID, 'won')]));
      expect(r).toMatchObject({ classification: 'DISPUTE_WON_VERIFIED', amounts: { lossMinor: 0, extent: 'none' }, mayQualifyForFutureRecoveryReview: false, requiresReconciliation: false });
      expect(r.advisories).toContain('DISPUTE_WON_DOES_NOT_REVERSE_CONSUMPTION');
    });
    it('a won dispute does not hide a refund loss that is separately verified', () => {
      expect(run(withItems([refund('re_1', PAID)], [dispute('dp_1', PAID, 'won')])).classification).toBe('FULL_REFUND_VERIFIED');
      expect(run(withItems([refund('re_1', 100)], [dispute('dp_1', PAID, 'won')])).classification).toBe('PARTIAL_REFUND_VERIFIED');
    });
    it('the classifier can only ever return one of the nine specified classes', () => {
      const nine = ['NO_REFUND', 'FULL_REFUND_VERIFIED', 'PARTIAL_REFUND_VERIFIED', 'REFUND_PENDING', 'DISPUTE_OPEN', 'DISPUTE_LOST_VERIFIED', 'DISPUTE_WON_VERIFIED', 'CONTRADICTORY_EVIDENCE', 'PROVIDER_UNREACHABLE'];
      const seen = new Set<string>();
      for (const m of [undefined, withItems([refund('a', PAID)]), withItems([refund('a', 1)]), withItems([refund('a', 1, 'pending', null)]), withItems([], [dispute('d', 1, 'open')]),
        withItems([], [dispute('d', PAID, 'lost')]), withItems([], [dispute('d', 1, 'won')]), withItems([refund('a', -1)]), (_: any, e: any) => { e.provenance.providerOutcome = 'unreachable'; }])
        seen.add(run(m).classification);
      expect([...seen].sort()).toEqual([...nine].sort());
    });
  });

  describe('refund conservation', () => {
    it('8. multiple independent refunds are summed once each: partial then full', () => {
      expect(run(withItems([refund('re_1', 3_000), refund('re_2', 2_000)]))).toMatchObject({ classification: 'PARTIAL_REFUND_VERIFIED', amounts: { lossMinor: 5_000 } });
      expect(run(withItems([refund('re_1', 6_000), refund('re_2', 4_000)]))).toMatchObject({ classification: 'FULL_REFUND_VERIFIED', amounts: { lossMinor: PAID } });
    });
    it('9. a duplicate refund event is counted once; its amount cannot raise the loss total', () => {
      const r = run(withItems([refund('re_1', 3_000), refund('re_1', 3_000), refund('re_1', 3_000)]));
      expect(r).toMatchObject({ classification: 'PARTIAL_REFUND_VERIFIED', amounts: { lossMinor: 3_000 }, evidenceRefs: { refundRefs: ['re_1'] } });
      expect(r.advisories).toContain('DUPLICATE_OBSERVATION_IGNORED');
      // duplicates must not turn a partial into a full refund
      expect(run(withItems([refund('re_1', 6_000), refund('re_1', 6_000)])).classification).toBe('PARTIAL_REFUND_VERIFIED');
    });
    it('10. duplicate dispute observations are one dispute', () => {
      const r = run(withItems([], [dispute('dp_1', 3_000, 'lost'), dispute('dp_1', 3_000, 'lost')]));
      expect(r).toMatchObject({ classification: 'DISPUTE_LOST_VERIFIED', amounts: { lossMinor: 3_000 } }); expect(r.advisories).toContain('DUPLICATE_OBSERVATION_IGNORED');
    });
    it('11. a refund greater than the payment, or refunds adding up to more, is CONTRADICTORY', () => {
      expectClass(run(withItems([refund('re_1', PAID + 1)])), 'CONTRADICTORY_EVIDENCE', 'AMOUNT_EXCEEDS_PAYMENT');
      expectClass(run(withItems([refund('re_1', 6_000), refund('re_2', 4_001)])), 'CONTRADICTORY_EVIDENCE', 'LOSS_EXCEEDS_PAYMENT');
      expectClass(run(withItems([], [dispute('dp_1', PAID + 1, 'lost')])), 'CONTRADICTORY_EVIDENCE', 'AMOUNT_EXCEEDS_PAYMENT');
    });
    it('12. a negative refund amount is CONTRADICTORY and never reduces another loss', () => {
      expectClass(run(withItems([refund('re_1', -500)])), 'CONTRADICTORY_EVIDENCE', 'AMOUNT_INVALID');
      expectClass(run(withItems([refund('re_1', 5_000), refund('re_2', -2_000)])), 'CONTRADICTORY_EVIDENCE', 'AMOUNT_INVALID');
      expectClass(run(withItems([], [dispute('dp_1', -1, 'lost')])), 'CONTRADICTORY_EVIDENCE', 'AMOUNT_INVALID');
    });
    it('13. a zero refund or dispute amount is CONTRADICTORY', () => {
      expectClass(run(withItems([refund('re_1', 0)])), 'CONTRADICTORY_EVIDENCE', 'AMOUNT_INVALID');
      expectClass(run(withItems([], [dispute('dp_1', 0, 'lost')])), 'CONTRADICTORY_EVIDENCE', 'AMOUNT_INVALID');
    });
    it('14. unsafe, fractional, NaN and non-numeric amounts are rejected as invalid input, never summed', () => {
      for (const v of [Number.MAX_SAFE_INTEGER + 1, 1.5, Number.NaN, Infinity, '100', null, undefined]) {
        expectClass(run(withItems([refund('re_1', v as any)])), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
        expectClass(run(withItems([], [dispute('dp_1', v as any, 'lost')])), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
      }
      expectClass(run((_, e) => { e.payment.paidMinor = Number.MAX_SAFE_INTEGER + 1; }), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
      expectClass(run((_, e) => { e.payment.paidMinor = 0; }), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
    });
    it('two refunds each safe but whose sum is unsafe are rejected, not wrapped', () => {
      const r = run((_, e) => { e.payment.paidMinor = Number.MAX_SAFE_INTEGER; e.refunds.items = [refund('a', Number.MAX_SAFE_INTEGER), refund('b', Number.MAX_SAFE_INTEGER)]; });
      expect(['PROVIDER_UNREACHABLE', 'CONTRADICTORY_EVIDENCE']).toContain(r.classification); expect(r.amounts.lossMinor).toBeNull();
    });
    it('33. duplicate evidence with conflicting amounts or finality is CONTRADICTORY', () => {
      expectClass(run(withItems([refund('re_1', 3_000), refund('re_1', 3_001)])), 'CONTRADICTORY_EVIDENCE', 'DUPLICATE_CONFLICT');
      expectClass(run(withItems([refund('re_1', 3_000, 'succeeded'), refund('re_1', 3_000, 'pending', null)])), 'CONTRADICTORY_EVIDENCE', 'DUPLICATE_CONFLICT');
      expectClass(run(withItems([], [dispute('dp_1', 3_000, 'lost'), dispute('dp_1', 3_000, 'won')])), 'CONTRADICTORY_EVIDENCE', 'DUPLICATE_CONFLICT');
    });
    it('23. contradictory dispute states: one id with two outcomes, or several distinct disputes on one payment (no rule exists to combine them)', () => {
      expectClass(run(withItems([], [dispute('dp_1', 3_000, 'open', null, null), dispute('dp_1', 3_000, 'lost')])), 'CONTRADICTORY_EVIDENCE', 'DUPLICATE_CONFLICT');
      expectClass(run(withItems([], [dispute('dp_1', 3_000, 'lost'), dispute('dp_2', 2_000, 'lost')])), 'CONTRADICTORY_EVIDENCE', 'MULTIPLE_DISPUTES_UNDEFINED');
      expectClass(run(withItems([], [dispute('dp_1', 3_000, 'won'), dispute('dp_2', 3_000, 'lost')])), 'CONTRADICTORY_EVIDENCE', 'MULTIPLE_DISPUTES_UNDEFINED');
    });
  });

  describe('overlap of a refund and a lost dispute (never summed by assumption)', () => {
    it('25. a refund and a dispute that the provider states are the SAME loss are counted once', () => {
      const r = run(withItems([refund('re_1', 4_000)], [dispute('dp_1', 4_000, 'lost', ['re_1'])]));
      expect(r).toMatchObject({ classification: 'DISPUTE_LOST_VERIFIED', amounts: { lossMinor: 4_000, extent: 'partial' }, requiresReconciliation: true });
      const full = run(withItems([refund('re_1', PAID)], [dispute('dp_1', PAID, 'lost', ['re_1'])]));
      expect(full).toMatchObject({ classification: 'DISPUTE_LOST_VERIFIED', amounts: { lossMinor: PAID, extent: 'full' } });
    });
    it('25b. an unknown overlap is CONTRADICTORY: the specification does not say how the losses combine', () => {
      for (const o of [null, undefined]) expectClass(run(withItems([refund('re_1', 4_000)], [dispute('dp_1', 4_000, 'lost', o as any)])), 'CONTRADICTORY_EVIDENCE', 'LOSS_OVERLAP_UNDEFINED');
    });
    it('25c. a stated same-loss with different amounts, or naming an unknown refund, is CONTRADICTORY', () => {
      expectClass(run(withItems([refund('re_1', 3_000)], [dispute('dp_1', 4_000, 'lost', ['re_1'])])), 'CONTRADICTORY_EVIDENCE', 'OVERLAP_AMOUNT_CONFLICT');
      expectClass(run(withItems([refund('re_1', 4_000)], [dispute('dp_1', 4_000, 'lost', ['re_ghost'])])), 'CONTRADICTORY_EVIDENCE', 'OVERLAP_REFERENCE_UNKNOWN');
      expectClass(run(withItems([refund('re_1', 4_000)], [dispute('dp_1', 4_000, 'lost', ['re_1', 're_1'])])), 'CONTRADICTORY_EVIDENCE', 'OVERLAP_REFERENCE_UNKNOWN');
    });
    it('26. losses the provider states are different are added; a total above the payment is CONTRADICTORY', () => {
      expect(run(withItems([refund('re_1', 3_000)], [dispute('dp_1', 2_000, 'lost', [])]))).toMatchObject({ classification: 'DISPUTE_LOST_VERIFIED', amounts: { lossMinor: 5_000, extent: 'partial' } });
      expect(run(withItems([refund('re_1', 6_000)], [dispute('dp_1', 4_000, 'lost', [])]))).toMatchObject({ classification: 'DISPUTE_LOST_VERIFIED', amounts: { lossMinor: PAID, extent: 'full' }, mayQualifyForFutureRecoveryReview: true });
      expectClass(run(withItems([refund('re_1', 6_000)], [dispute('dp_1', 4_001, 'lost', [])])), 'CONTRADICTORY_EVIDENCE', 'LOSS_EXCEEDS_PAYMENT');
    });
  });

  describe('scope: tenant, account, mode, invoice, payment, currency', () => {
    it('15. a currency mismatch is CONTRADICTORY and is never converted (payment, refund, dispute)', () => {
      expectClass(run((_, e) => { e.payment.currency = 'eur'; }), 'CONTRADICTORY_EVIDENCE', 'CURRENCY_MISMATCH');
      expectClass(run((_, e) => { e.refunds.items = [{ ...refund('re_1', 1_000), currency: 'eur' }]; }), 'CONTRADICTORY_EVIDENCE', 'CURRENCY_MISMATCH');
      expectClass(run((_, e) => { e.disputes.items = [{ ...dispute('dp_1', 1_000, 'lost'), currency: 'eur' }]; }), 'CONTRADICTORY_EVIDENCE', 'CURRENCY_MISMATCH');
    });
    it('16. an invoice mismatch: another invoice for the whole snapshot is unverifiable; a single record naming another invoice is CONTRADICTORY', () => {
      expectClass(run((_, e) => { e.payment.invoiceRef = 'in_other'; }), 'PROVIDER_UNREACHABLE', 'INVOICE_MISMATCH');
      expectClass(run((_, e) => { e.refunds.items = [{ ...refund('re_1', 1_000), invoiceRef: 'in_other' }]; }), 'CONTRADICTORY_EVIDENCE', 'INVOICE_MISMATCH');
      expectClass(run((_, e) => { e.disputes.items = [{ ...dispute('dp_1', 1_000, 'lost'), invoiceRef: 'in_other' }]; }), 'CONTRADICTORY_EVIDENCE', 'INVOICE_MISMATCH');
    });
    it('17. a payment mismatch: the same two levels', () => {
      expectClass(run((_, e) => { e.payment.ref = 'pi_other'; }), 'PROVIDER_UNREACHABLE', 'PAYMENT_MISMATCH');
      expectClass(run((_, e) => { e.refunds.items = [{ ...refund('re_1', 1_000), paymentRef: 'pi_other' }]; }), 'CONTRADICTORY_EVIDENCE', 'PAYMENT_MISMATCH');
      expectClass(run((_, e) => { e.disputes.items = [{ ...dispute('dp_1', 1_000, 'lost'), paymentRef: 'pi_other' }]; }), 'CONTRADICTORY_EVIDENCE', 'PAYMENT_MISMATCH');
    });
    it('18. cross-tenant evidence is rejected at the snapshot and at the record level, with manual review', () => {
      const a = run((_, e) => { e.binding.businessId = 'biz-2'; }); expectClass(a, 'PROVIDER_UNREACHABLE', 'TENANT_MISMATCH'); expect(a.manualReviewRequired).toBe(true);
      expectClass(run((_, e) => { e.refunds.items = [{ ...refund('re_1', PAID), businessId: 'biz-2' }]; }), 'PROVIDER_UNREACHABLE', 'TENANT_MISMATCH');
      expectClass(run((_, e) => { e.disputes.items = [{ ...dispute('dp_1', PAID, 'lost'), businessId: 'biz-2' }]; }), 'PROVIDER_UNREACHABLE', 'TENANT_MISMATCH');
    });
    it('19. a wrong Stripe account is rejected with manual review', () => { const r = run((_, e) => { e.provider.accountId = 'acct_other'; }); expectClass(r, 'PROVIDER_UNREACHABLE', 'SCOPE_MISMATCH'); expect(r.manualReviewRequired).toBe(true); });
    it('20. a wrong mode is rejected in both directions', () => {
      expectClass(run((_, e) => { e.provider.mode = 'live'; }), 'PROVIDER_UNREACHABLE', 'SCOPE_MISMATCH');
      expectClass(run(c => { c.expected.providerMode = 'live'; }), 'PROVIDER_UNREACHABLE', 'SCOPE_MISMATCH');
    });
  });

  describe('finality, precedence and unsupported combinations', () => {
    it('21. unknown refund finality can never produce a verified final classification', () => {
      for (const f of ['unknown', 'mystery', undefined, null]) {
        const r = run(withItems([{ ...refund('re_1', PAID, 'succeeded', null), finality: f }]));
        expect(['PROVIDER_UNREACHABLE', 'REFUND_PENDING']).toContain(r.classification);
        expect(r.mayQualifyForFutureRecoveryReview).toBe(false);
      }
      expectClass(run(withItems([refund('re_1', PAID, 'unknown', null)])), 'REFUND_PENDING', 'REFUND_FINALITY_UNKNOWN');
      expectClass(run(withItems([refund('re_1', PAID, 'failed', null)])), 'REFUND_PENDING', 'REFUND_NOT_SUCCEEDED');
      expectClass(run(withItems([refund('re_1', PAID, 'canceled', null)])), 'REFUND_PENDING', 'REFUND_NOT_SUCCEEDED');
    });
    it('22. an unknown dispute outcome is treated as open (fail closed), never as a loss or a win', () => {
      expectClass(run(withItems([], [dispute('dp_1', PAID, 'unknown', null, null)])), 'DISPUTE_OPEN', 'DISPUTE_OUTCOME_UNKNOWN');
      expect(run(withItems([], [dispute('dp_1', PAID, 'chargeback' as any, null, null)])).classification).toBe('PROVIDER_UNREACHABLE');
    });
    it('missing event identity cannot produce a verified classification', () => {
      for (const id of ['', undefined, null, 5]) {
        expectClass(run(withItems([{ ...refund('x', PAID), id }])), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
        expectClass(run(withItems([], [{ ...dispute('x', PAID, 'lost'), id }])), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
      }
    });
    it('40. precedence and unsupported combinations fail closed', () => {
      // 1 unreachable > 2 contradictory > 3 open dispute > 4 pending refund > 5 final loss
      expectClass(run((_, e) => { e.provenance.providerOutcome = 'unreachable'; e.refunds.items = [refund('re_1', -1)]; }), 'PROVIDER_UNREACHABLE');
      expectClass(run(withItems([refund('re_1', -1)], [dispute('dp_1', 1, 'open', null, null)])), 'CONTRADICTORY_EVIDENCE');
      expectClass(run(withItems([refund('re_1', PAID)], [dispute('dp_1', 1_000, 'open', null, null)])), 'DISPUTE_OPEN');
      expectClass(run(withItems([refund('re_1', 6_000), refund('re_2', 4_000, 'pending', null)])), 'REFUND_PENDING');
      expectClass(run(withItems([refund('re_1', 4_000)], [dispute('dp_1', 6_000, 'lost', null)])), 'CONTRADICTORY_EVIDENCE', 'LOSS_OVERLAP_UNDEFINED');
      expectClass(run(withItems([refund('re_1', PAID)], [dispute('dp_1', 1, 'open', null, null), dispute('dp_2', 1, 'open', null, null)])), 'CONTRADICTORY_EVIDENCE', 'MULTIPLE_DISPUTES_UNDEFINED');
      // a lost dispute never reads as a refund, a refund never reads as a lost dispute
      expect(run(withItems([], [dispute('dp_1', PAID, 'lost')])).classification).not.toBe('FULL_REFUND_VERIFIED');
      expect(run(withItems([refund('re_1', PAID)])).classification).not.toBe('DISPUTE_LOST_VERIFIED');
    });
    it('relativeToConsumption says whether the first final loss came before or after consumption, and is unknown otherwise', () => {
      expect(run(withItems([refund('re_1', PAID, 'succeeded', 7_000_000)])).relativeToConsumption).toBe('before');
      expect(run(withItems([refund('re_1', PAID, 'succeeded', 8_000_000)])).relativeToConsumption).toBe('after');
      expect(run(withItems([refund('re_1', PAID, 'succeeded', null)])).relativeToConsumption).toBe('unknown');
      expect(run((c, e) => { c.expected.consumedAtMs = null; e.refunds.items = [refund('re_1', PAID)]; }).relativeToConsumption).toBe('unknown');
      expect(run().relativeToConsumption).toBe('unknown');
    });
  });

  describe('provider, completeness, freshness and stability', () => {
    it('27. a provider that was unreachable, rate limited or failed is PROVIDER_UNREACHABLE', () => {
      for (const o of ['unreachable', 'rate_limited', 'permanent_error']) expectClass(run((_, e) => { e.provenance.providerOutcome = o; }), 'PROVIDER_UNREACHABLE', 'PROVIDER_UNREACHABLE');
    });
    it('truncated lists never support "no refund": incomplete is PROVIDER_UNREACHABLE', () => {
      for (const f of [(e: any) => { e.provenance.complete = false; }, (e: any) => { e.refunds.complete = false; }, (e: any) => { e.disputes.complete = false; }]) expectClass(run((_, e) => f(e)), 'PROVIDER_UNREACHABLE', 'INCOMPLETE_EVIDENCE');
      expectClass(run((_, e) => { e.provenance.complete = false; e.refunds.items = [refund('re_1', PAID)]; }), 'PROVIDER_UNREACHABLE', 'INCOMPLETE_EVIDENCE');
    });
    it('F-2: completeness must be exactly boolean true in all three fields; no other value establishes it (never NO_REFUND or any verified class)', () => {
      const bad: unknown[] = [false, null, undefined, 'true', 'false', 'yes', '', 1, 0, -1, 1.5, Number.NaN, {}, [], [true], Symbol.for('x')];
      const setters: Array<[string, (e: any, v: unknown) => void]> = [['provenance', (e, v) => { e.provenance.complete = v; }], ['refunds', (e, v) => { e.refunds.complete = v; }], ['disputes', (e, v) => { e.disputes.complete = v; }]];
      for (const [name, set] of setters) for (const v of bad) {
        for (const items of [withItems([]), withItems([refund('re_1', PAID)]), withItems([], [dispute('dp_1', PAID, 'lost')])]) {
          const r = run((c, e) => { items(c, e); set(e, v); });
          expect(r.classification, `${name}=${String(v)}`).toBe('PROVIDER_UNREACHABLE'); expect(r.reasonCodes).toContain('INCOMPLETE_EVIDENCE'); expect(r.mayQualifyForFutureRecoveryReview).toBe(false);
        }
      }
      expect(run((_, e) => { e.provenance.complete = true; e.refunds.complete = true; e.disputes.complete = true; }).classification).toBe('NO_REFUND'); // valid control
    });
    it('29. stale observations never support a verified class; exactly the window is fresh; future-dated evidence is refused', () => {
      expectClass(run((_, e) => { e.provenance.observedAtMs = NOW - 60_001; }), 'PROVIDER_UNREACHABLE', 'STALE_EVIDENCE');
      expect(run((_, e) => { e.provenance.observedAtMs = NOW - 60_000; }).classification).toBe('NO_REFUND');
      expectClass(run((_, e) => { e.provenance.observedAtMs = NOW + 1; }), 'PROVIDER_UNREACHABLE', 'EVIDENCE_FROM_FUTURE');
    });
    it('the freshness window is a policy dependency with no default: absent or invalid means no verified class can be returned', () => {
      for (const w of [null, undefined, -1, 1.5, Number.NaN, '60000']) {
        const r = run(c => { c.policy.freshnessWindowMs = w; });
        expectClass(r, 'PROVIDER_UNREACHABLE', 'FRESHNESS_POLICY_UNAVAILABLE'); expect(r.outstandingUncertainties).toContain('an owner-approved freshness window (OQ-7)');
      }
      expect(run(c => { delete c.policy.freshnessWindowMs; }).classification).toBe('PROVIDER_UNREACHABLE');
    });
    it('24/30. conflicting provider observations and unstable bracketed reads are CONTRADICTORY', () => {
      expectClass(runAfter((_, e) => { e.provenance.readAfter = { ...e.provenance.readAfter, contentDigest: D('d') }; }), 'CONTRADICTORY_EVIDENCE', 'EVIDENCE_UNSTABLE');
      expectClass(runAfter((_, e) => { e.provenance.readAfter = { ...e.provenance.readAfter, refundCount: 1 }; }), 'CONTRADICTORY_EVIDENCE', 'EVIDENCE_UNSTABLE');
      expectClass(runAfter((_, e) => { e.provenance.readBefore = { ...e.provenance.readBefore, paidMinor: PAID + 1 }; e.provenance.readAfter = { ...e.provenance.readBefore }; }), 'CONTRADICTORY_EVIDENCE', 'EVIDENCE_UNSTABLE'); // reads agree with each other, not with the evaluated payment
      expectClass(runAfter((_, e) => { e.refunds.items = [refund('re_1', PAID)]; }), 'CONTRADICTORY_EVIDENCE', 'EVIDENCE_UNSTABLE'); // reads disagree with the list actually evaluated
      expectClass(runAfter((_, e) => { e.provenance.readAfter = null; }), 'PROVIDER_UNREACHABLE', 'INCOMPLETE_EVIDENCE');
    });
    it('policy version: missing or different fails closed', () => {
      for (const v of [null, '']) expectClass(run(c => { c.policy.version = v; }), 'PROVIDER_UNREACHABLE', 'POLICY_VERSION_MISSING');
      expectClass(run(c => { c.policy.version = 'PC-BENEFIT/2'; }), 'PROVIDER_UNREACHABLE', 'POLICY_VERSION_MISMATCH');
    });
  });

  describe('malformed, missing and untrusted evidence', () => {
    it('28. a missing or malformed evidence digest is rejected', () => {
      for (const d of [undefined, null, '', 'short', 'g'.repeat(64), 'A'.repeat(64)]) expectClass(run((_, e) => { e.provenance.snapshotDigest = d; }), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
      expectClass(run((_, e) => { e.provenance.snapshotRef = ''; }), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
      expectClass(runAfter((_, e) => { e.provenance.readBefore = { paidMinor: PAID, refundCount: 0, disputeCount: 0, contentDigest: 'nope' }; }), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
    });
    it('31. a malformed mock payload fails closed without throwing', () => {
      const [c, e] = build();
      for (const bad of [{}, { provenance: {} }, 42, 'x', [], null, undefined]) expect(classifyRefundDispute(c, bad as any).classification).toBe('PROVIDER_UNREACHABLE');
      for (const bad of [null, undefined, {}, { nowMs: 1 }, { ...c, nowMs: 'x' }, { ...c, expected: null }, { ...c, policy: null }]) expect(classifyRefundDispute(bad as any, e).classification).toBe('PROVIDER_UNREACHABLE');
      for (const k of ['provenance', 'binding', 'provider', 'payment', 'refunds', 'disputes']) expectClass(runAfter((_, ev) => { delete ev[k]; }), 'PROVIDER_UNREACHABLE', 'EVIDENCE_MISSING');
      expectClass(runAfter((_, ev) => { ev.refunds.items = 'nope'; }), 'PROVIDER_UNREACHABLE', 'EVIDENCE_MISSING');
      expectClass(runAfter((_, ev) => { ev.refunds.items = [null]; }), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
      expectClass(runAfter((_, ev) => { ev.disputes.items = [{ id: 'dp', overlapsRefundIds: 'x' }]; }), 'PROVIDER_UNREACHABLE', 'INPUT_INVALID');
    });
    it('32. a non-mock evidence kind or an untrusted origin (a webhook body) is refused', () => {
      for (const k of ['STRIPE_VERIFIED', 'LIVE', '', undefined]) expectClass(run((_, e) => { e.provenance.evidenceKind = k; }), 'PROVIDER_UNREACHABLE', 'EVIDENCE_KIND_UNSUPPORTED');
      for (const o of ['webhook_body', 'client', '', undefined]) { const r = run((_, e) => { e.provenance.origin = o; }); expectClass(r, 'PROVIDER_UNREACHABLE', 'EVIDENCE_ORIGIN_UNTRUSTED'); expect(r.manualReviewRequired).toBe(true); }
    });
  });

  describe('authority and leakage', () => {
    it('37. no financial authority is ever granted, and the output carries no instruction or authorization field', () => {
      for (const m of [undefined, withItems([refund('re_1', PAID)]), withItems([], [dispute('dp_1', PAID, 'lost')]), withItems([refund('re_1', 100)]), (_: any, e: any) => { e.provenance.providerOutcome = 'unreachable'; }]) {
        const r = run(m);
        expect(r.grantsFinancialAuthority).toBe(false);
        const keys: string[] = []; const walk = (o: any) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.push(k); walk(v); } }; walk(r);
        expect(keys.filter(k => /authoriz|instruction|execute|^reverse|release|obligation/i.test(k))).toEqual([]); // `relativeToConsumption` is an evidence statement, not an instruction
      }
    });
    it('any asserted authority key anywhere in the evidence or context is refused (case-insensitive)', () => {
      const attacks: Array<(c: any, e: any) => void> = [(_, e) => { e.consumptionAuthorized = true; }, (_, e) => { e.reversalAuthorized = true; }, (_, e) => { e.refunds.items = [{ ...refund('re_1', PAID), approved: true }]; },
        (_, e) => { e.provenance.Trusted = 1; }, (_, e) => { e.payment.VERIFIED = true; }, (c, _) => { c.policy.authorized = 'yes'; }, (_, e) => { e.disputes.items = [{ ...dispute('dp', 1, 'won'), eligible: true }]; }];
      for (const a of attacks) {
        const r = run(a);
        // `reversalAuthorized` is not in the shared authority list; it must still not be able to change the outcome
        if (r.reasonCodes.includes('CALLER_AUTHORITY_ASSERTED')) { expect(r.classification).toBe('PROVIDER_UNREACHABLE'); expect(r.manualReviewRequired).toBe(true); }
        expect(r.grantsFinancialAuthority).toBe(false); expect(r.mayQualifyForFutureRecoveryReview).toBe(false);
      }
      expect(run((_, e) => { e.reversalAuthorized = true; e.refunds.items = [refund('re_1', 100)]; }).classification).toBe('PARTIAL_REFUND_VERIFIED');
    });
    it('a webhook-style claim without independent facts cannot create a verified loss', () => {
      expectClass(run((_, e) => { e.provenance.origin = 'webhook_body'; e.refunds.items = [refund('re_1', PAID)]; }), 'PROVIDER_UNREACHABLE', 'EVIDENCE_ORIGIN_UNTRUSTED');
    });
    it('38. provider text, secrets and unknown fields are never echoed; refs are restricted to safe identifiers', () => {
      const [c, e] = build((_, ev) => { ev.rawPayload = 'sk_live_SECRET_VALUE'; ev.refunds.items = [{ ...refund('re_1', 100), receiptUrl: 'https://x/secret', failureMessage: 'card 4242 declined' }]; ev.provenance.snapshotRef = 'snap with spaces <script>'; });
      const r = classifyRefundDispute(c, e);
      expect(JSON.stringify(r)).not.toMatch(/sk_live|SECRET|receiptUrl|secret|4242|script|spaces/);
      expect(r.evidenceRefs.snapshotRef).toBeNull(); expect(r.evidenceRefs.refundRefs).toEqual(['re_1']);
    });
    it('evaluated identity is the trusted expected identity, never the response', () => {
      const r = run((_, e) => { e.provider.accountId = 'acct_other'; });
      expect(r.evaluated).toMatchObject({ providerAccountId: 'acct_1', businessId: 'biz-1', paymentRef: 'pi_1' });
    });
  });

  describe('determinism, immutability, purity', () => {
    it('34. replay: the same input always gives the same output', () => {
      const [c, e] = build(withItems([refund('re_1', 3_000), refund('re_2', 2_000)]));
      const a = classifyRefundDispute(c, e);
      for (let i = 0; i < 5; i++) expect(classifyRefundDispute(c, e)).toEqual(a);
      expect(classifyRefundDispute(...build(withItems([refund('re_1', 3_000), refund('re_2', 2_000)])))).toEqual(a);
    });
    it('35. the input is never mutated (deep-frozen input classifies without error)', () => {
      const [c, e] = build(withItems([refund('re_1', 3_000), refund('re_1', 3_000)], [dispute('dp_1', 1_000, 'lost', [])]));
      const before = JSON.stringify([c, e]);
      const freeze = (o: any): any => { Object.values(o).forEach(v => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(o); };
      freeze(c); freeze(e);
      expect(() => classifyRefundDispute(c, e)).not.toThrow();
      expect(JSON.stringify([c, e])).toBe(before);
    });
    it('36. the module has no provider, database, network, clock, randomness or environment dependency (only the DEV-01 trust helpers are imported)', () => {
      const src = readFileSync(resolve(__dirname, 'refund-dispute.classifier.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/Date\.now|new Date\(\)|Math\.random|process\.|fetch\(|crypto|require\(|\bawait\b|\basync\b|setTimeout|XMLHttp|WebSocket/);
      const imports = [...src.matchAll(/import\s+(?:type\s+)?\{[^}]*\}\s+from\s+'([^']+)'/g)].map(m => m[1]);
      expect(imports).toEqual(['./settlement-eligibility.classifier']);
      expect(imports.length).toBe(1); // the only dependency is the DEV-01 trust helpers: no unwind, compensator, consumption, ledger, database or provider module
      expect(src).not.toMatch(/\bstripe\b|drizzle|\.insert\(|\.update\(|\.delete\(|\.transaction\(|\.select\(/i);
    });
    it('39. a partial refund is an explicit reconciliation hold: no recovery eligibility, no recovery wording in the result', () => {
      const r = run(withItems([refund('re_1', 1)]));
      expect(r).toMatchObject({ classification: 'PARTIAL_REFUND_VERIFIED', requiresReconciliation: true, manualReviewRequired: true, mayQualifyForFutureRecoveryReview: false, grantsFinancialAuthority: false });
    });
  });

  describe('seeded randomized properties (conservation, replay, duplicates, order)', () => {
    const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const shuffle = <T,>(xs: T[], r: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
    it('over 300 random refund sets: the loss equals the sum of unique refunds, never exceeds the payment, and class follows the sum', () => {
      const r = rng(20261104);
      for (let n = 0; n < 300; n++) {
        const count = 1 + Math.floor(r() * 5);
        const amounts = Array.from({ length: count }, () => 1 + Math.floor(r() * 4_000));
        const refunds = amounts.map((a, i) => refund(`re_${n}_${i}`, a));
        const sum = amounts.reduce((x, y) => x + y, 0);
        const out = run(withItems(refunds));
        if (sum > PAID) { expect(out.classification).toBe('CONTRADICTORY_EVIDENCE'); expect(out.amounts.lossMinor).toBeNull(); continue; }
        expect(out.amounts.lossMinor).toBe(sum);
        expect(out.classification).toBe(sum === PAID ? 'FULL_REFUND_VERIFIED' : 'PARTIAL_REFUND_VERIFIED');
        expect(out.mayQualifyForFutureRecoveryReview).toBe(sum === PAID);
        // order independence and duplicate-insensitivity
        const shuffled = run(withItems(shuffle(refunds, r)));
        expect(shuffled.classification).toBe(out.classification); expect(shuffled.amounts).toEqual(out.amounts); expect(shuffled.evidenceRefs.refundRefs).toEqual(out.evidenceRefs.refundRefs);
        const dup = run(withItems(shuffle([...refunds, ...refunds.slice(0, 1 + Math.floor(r() * count))], r)));
        expect(dup.classification).toBe(out.classification); expect(dup.amounts).toEqual(out.amounts);
        expect(run(withItems(refunds))).toEqual(out);
      }
    });
    it('over 200 random sets with a non-final refund or open dispute: never a verified loss', () => {
      const r = rng(7);
      for (let n = 0; n < 200; n++) {
        const refunds = [refund(`re_a${n}`, 1 + Math.floor(r() * 3_000)), refund(`re_b${n}`, 1 + Math.floor(r() * 3_000), ['pending', 'failed', 'canceled', 'requires_action', 'unknown'][Math.floor(r() * 5)], null)];
        const out = run(withItems(refunds));
        expect(out.classification).toBe('REFUND_PENDING'); expect(out.mayQualifyForFutureRecoveryReview).toBe(false); expect(out.amounts.lossMinor).toBeNull();
        const withOpen = run(withItems(refunds, [dispute(`dp_${n}`, 1 + Math.floor(r() * 3_000), r() < 0.5 ? 'open' : 'unknown', null, null)]));
        expect(withOpen.classification).toBe('DISPUTE_OPEN');
      }
    });
    it('over 200 random refund/lost-dispute pairs with unknown overlap: always CONTRADICTORY, never summed', () => {
      const r = rng(99);
      for (let n = 0; n < 200; n++) {
        const out = run(withItems([refund(`re_${n}`, 1 + Math.floor(r() * 4_000))], [dispute(`dp_${n}`, 1 + Math.floor(r() * 4_000), 'lost', null)]));
        expect(out.classification).toBe('CONTRADICTORY_EVIDENCE'); expect(out.reasonCodes).toContain('LOSS_OVERLAP_UNDEFINED'); expect(out.amounts.lossMinor).toBeNull();
      }
    });
  });
});
