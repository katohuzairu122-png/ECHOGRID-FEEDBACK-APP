import {
  MOCK_EVIDENCE_KIND, SUPPORTED_BENEFIT_POLICY_VERSION, assertsAuthority, isInt, isNonNegInt, isStr, safeRef, DIGEST,
  type ProviderMode, type ProviderOutcome,
} from './settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-02: PURE refund and Stripe payment-dispute classifier (design: docs/architecture/builds/SPLIT-08/S08_D1D3_REFUND_DISPUTE_CLASSIFIER_SPEC.md, owner decision S08-D1D3/1, D3-g).
 *
 * EVIDENCE-ONLY. It names what already-verified, SYNTHETIC mock evidence about one payment means. It reads no database, calls no provider, holds no clock, mutates nothing and
 * returns no provider payload. It grants no financial authority and carries no instruction: it creates no recovery obligation, reverses no consumption, releases no
 * reservation and modifies no balance. It is NOT connected to the compensator, the unwind routine, D4 consumption or any ledger. "Dispute" here is a Stripe PAYMENT dispute
 * and has nothing to do with the frozen Split 07 award-dispute hold.
 *
 * Trust and identity conventions (mock evidence kind, policy pin, authority-assertion scan, safe references) are reused from DEV-01, not re-implemented.
 *
 * Fail closed. Two rules keep the nine classes honest where the specification has no tenth: evidence that cannot be verified or is structurally invalid is
 * PROVIDER_UNREACHABLE (nothing can be concluded); evidence that parses but disagrees with itself or with the expected scope is CONTRADICTORY_EVIDENCE.
 */
export const REFUND_DISPUTE_CLASSIFIER_VERSION = 'S08-D1D3-REFUND-DISPUTE/1' as const;
export const DECISION_RECORD = 'S08-D1D3/1' as const;
export const EVIDENCE_ORIGIN = 'independent_read' as const;

export type RefundDisputeClass =
  | 'NO_REFUND' | 'FULL_REFUND_VERIFIED' | 'PARTIAL_REFUND_VERIFIED' | 'REFUND_PENDING'
  | 'DISPUTE_OPEN' | 'DISPUTE_LOST_VERIFIED' | 'DISPUTE_WON_VERIFIED'
  | 'CONTRADICTORY_EVIDENCE' | 'PROVIDER_UNREACHABLE';
export type Extent = 'none' | 'partial' | 'full' | 'unknown';
export type RefundFinality = 'succeeded' | 'pending' | 'requires_action' | 'failed' | 'canceled' | 'unknown';
export type DisputeOutcome = 'open' | 'won' | 'lost' | 'unknown';

/** Trusted inputs: configuration and tenant-checked persisted records. Never taken from the provider response or a caller assertion. */
export interface RefundDisputeContext {
  readonly nowMs: number;
  readonly policy: Readonly<{
    version: string | null;
    /** Freshness window F. UNDECIDED by the owner (OQ-7): when absent no verified class can be returned. */
    freshnessWindowMs: number | null;
  }>;
  readonly expected: Readonly<{
    businessId: string; invoiceRef: string; paymentRef: string; currency: string;
    providerAccountId: string; providerMode: ProviderMode;
    /** When the credit was consumed (persisted record), to say whether a loss came before or after; null when not consumed or unknown. */
    consumedAtMs: number | null;
  }>;
}

export interface MockRefund {
  readonly id: string; readonly businessId: string; readonly invoiceRef: string; readonly paymentRef: string; readonly currency: string;
  readonly amountMinor: number; readonly finality: RefundFinality; readonly finalizedAtMs: number | null;
}
export interface MockPaymentDispute {
  readonly id: string; readonly businessId: string; readonly invoiceRef: string; readonly paymentRef: string; readonly currency: string;
  readonly amountMinor: number; readonly outcome: DisputeOutcome; readonly closedAtMs: number | null;
  /**
   * Refund ids the provider states are the SAME loss as this dispute. null/absent = unknown; [] = provider-stated disjoint. The specification does not say how a refund and a
   * lost dispute on one payment overlap, so unknown overlap is never summed (CONTRADICTORY_EVIDENCE).
   */
  readonly overlapsRefundIds: readonly string[] | null;
}
export interface ReadFingerprint {
  readonly paidMinor: number; readonly refundCount: number; readonly disputeCount: number; readonly contentDigest: string;
}

export interface MockRefundDisputeEvidence {
  readonly provenance: Readonly<{
    evidenceKind: typeof MOCK_EVIDENCE_KIND; origin: typeof EVIDENCE_ORIGIN;
    snapshotRef: string; snapshotDigest: string; observedAtMs: number; providerOutcome: ProviderOutcome;
    complete: boolean; readBefore: ReadFingerprint | null; readAfter: ReadFingerprint | null;
  }>;
  readonly binding: Readonly<{ businessId: string }>;
  readonly provider: Readonly<{ accountId: string; mode: ProviderMode }>;
  readonly payment: Readonly<{ ref: string; invoiceRef: string; currency: string; paidMinor: number }>;
  readonly refunds: Readonly<{ complete: boolean; items: readonly MockRefund[] }>;
  readonly disputes: Readonly<{ complete: boolean; items: readonly MockPaymentDispute[] }>;
}

export type RefundDisputeReason =
  | 'NO_REFUND_OR_DISPUTE_VERIFIED' | 'FULL_REFUND_VERIFIED' | 'PARTIAL_LOSS_VERIFIED' | 'DISPUTE_LOST_VERIFIED' | 'DISPUTE_WON_VERIFIED'
  | 'INPUT_INVALID' | 'EVIDENCE_MISSING' | 'EVIDENCE_KIND_UNSUPPORTED' | 'EVIDENCE_ORIGIN_UNTRUSTED' | 'CALLER_AUTHORITY_ASSERTED'
  | 'PROVIDER_UNREACHABLE' | 'TENANT_MISMATCH' | 'SCOPE_MISMATCH' | 'POLICY_VERSION_MISSING' | 'POLICY_VERSION_MISMATCH'
  | 'INCOMPLETE_EVIDENCE' | 'FRESHNESS_POLICY_UNAVAILABLE' | 'STALE_EVIDENCE' | 'EVIDENCE_FROM_FUTURE'
  | 'EVIDENCE_UNSTABLE' | 'CURRENCY_MISMATCH' | 'INVOICE_MISMATCH' | 'PAYMENT_MISMATCH' | 'AMOUNT_INVALID' | 'AMOUNT_EXCEEDS_PAYMENT' | 'LOSS_EXCEEDS_PAYMENT'
  | 'DUPLICATE_CONFLICT' | 'MULTIPLE_DISPUTES_UNDEFINED' | 'LOSS_OVERLAP_UNDEFINED' | 'OVERLAP_REFERENCE_UNKNOWN' | 'OVERLAP_AMOUNT_CONFLICT'
  | 'DISPUTE_OPEN' | 'DISPUTE_OUTCOME_UNKNOWN'
  | 'REFUND_PENDING' | 'REFUND_NOT_SUCCEEDED' | 'REFUND_FINALITY_UNKNOWN';

export interface RefundDisputeClassification {
  readonly classifierVersion: typeof REFUND_DISPUTE_CLASSIFIER_VERSION;
  readonly decisionRecord: typeof DECISION_RECORD;
  readonly classification: RefundDisputeClass;
  readonly reasonCodes: readonly RefundDisputeReason[];
  readonly advisories: readonly string[];
  readonly evidenceRefs: Readonly<{ snapshotRef: string | null; snapshotDigest: string | null; refundRefs: readonly string[]; disputeRefs: readonly string[] }>;
  /** The identity that was evaluated: the trusted expected values, never the response. */
  readonly evaluated: Readonly<{ businessId: string | null; invoiceRef: string | null; paymentRef: string | null; currency: string | null; providerAccountId: string | null; providerMode: ProviderMode | null }>;
  readonly amounts: Readonly<{ paidMinor: number | null; lossMinor: number | null; extent: Extent }>;
  readonly relativeToConsumption: 'before' | 'after' | 'unknown';
  readonly outstandingUncertainties: readonly string[];
  readonly manualReviewRequired: boolean;
  readonly requiresReconciliation: boolean;
  /**
   * Evidence statement only (D3-g): a full refund or fully lost dispute MAY qualify for a future, separately authorized recovery review after independent verification.
   * It is not an instruction, a permission or an authorization of anything.
   */
  readonly mayQualifyForFutureRecoveryReview: boolean;
  readonly policyVersion: string | null;
  readonly evaluatedAt: string;
  readonly grantsFinancialAuthority: false;
}

const MANUAL: ReadonlySet<RefundDisputeReason> = new Set<RefundDisputeReason>([
  'INPUT_INVALID', 'EVIDENCE_KIND_UNSUPPORTED', 'EVIDENCE_ORIGIN_UNTRUSTED', 'CALLER_AUTHORITY_ASSERTED', 'TENANT_MISMATCH', 'SCOPE_MISMATCH', 'CURRENCY_MISMATCH', 'INVOICE_MISMATCH',
  'PAYMENT_MISMATCH', 'AMOUNT_INVALID', 'AMOUNT_EXCEEDS_PAYMENT', 'LOSS_EXCEEDS_PAYMENT', 'DUPLICATE_CONFLICT', 'MULTIPLE_DISPUTES_UNDEFINED', 'LOSS_OVERLAP_UNDEFINED',
  'OVERLAP_REFERENCE_UNKNOWN', 'OVERLAP_AMOUNT_CONFLICT', 'EVIDENCE_UNSTABLE', 'DISPUTE_OPEN', 'DISPUTE_OUTCOME_UNKNOWN', 'PARTIAL_LOSS_VERIFIED',
]);
const REQUIREMENT: Readonly<Partial<Record<RefundDisputeReason, string>>> = {
  PROVIDER_UNREACHABLE: 'a complete independent provider read', INCOMPLETE_EVIDENCE: 'complete evidence (all pages read)', STALE_EVIDENCE: 'a fresh observation',
  FRESHNESS_POLICY_UNAVAILABLE: 'an owner-approved freshness window (OQ-7)', EVIDENCE_UNSTABLE: 'two equal bracketing reads', SCOPE_MISMATCH: 'evidence from the configured account, mode, invoice and payment',
  TENANT_MISMATCH: 'tenant-matching evidence', POLICY_VERSION_MISSING: 'a policy version', POLICY_VERSION_MISMATCH: 'matching policy versions',
  DISPUTE_OPEN: 'a final dispute outcome', DISPUTE_OUTCOME_UNKNOWN: 'a known dispute outcome', REFUND_PENDING: 'a final refund state', REFUND_NOT_SUCCEEDED: 'a final refund state',
  REFUND_FINALITY_UNKNOWN: 'a known refund finality', PARTIAL_LOSS_VERIFIED: 'a separate owner-approved partial-refund policy (OQ-11)',
  LOSS_OVERLAP_UNDEFINED: 'provider-stated overlap between the refund and the dispute loss (OQ-16)', MULTIPLE_DISPUTES_UNDEFINED: 'a rule for several disputes on one payment (OQ-16)',
  DUPLICATE_CONFLICT: 'consistent repeated observations', AMOUNT_INVALID: 'valid refund and dispute amounts', AMOUNT_EXCEEDS_PAYMENT: 'amounts within the payment',
  LOSS_EXCEEDS_PAYMENT: 'losses within the payment', CURRENCY_MISMATCH: 'one currency', INVOICE_MISMATCH: 'evidence for this invoice', PAYMENT_MISMATCH: 'evidence for this payment',
  OVERLAP_REFERENCE_UNKNOWN: 'overlap references that name real refunds', OVERLAP_AMOUNT_CONFLICT: 'matching amounts for a stated same-loss', INPUT_INVALID: 'well-formed evidence',
  EVIDENCE_MISSING: 'the missing evidence', EVIDENCE_KIND_UNSUPPORTED: 'a supported evidence kind', EVIDENCE_ORIGIN_UNTRUSTED: 'an independent provider read (a webhook body is a signal only)',
  CALLER_AUTHORITY_ASSERTED: 'evidence without authority assertions', EVIDENCE_FROM_FUTURE: 'an observation that is not in the future',
};

type Out = { cls: RefundDisputeClass; codes: RefundDisputeReason[]; lossMinor?: number | null; extent?: Extent; lossTimes?: number[]; advisories?: string[]; refunds?: string[]; disputes?: string[] };
const UNREACH = (...codes: RefundDisputeReason[]): Out => ({ cls: 'PROVIDER_UNREACHABLE', codes });
const CONTRA = (...codes: RefundDisputeReason[]): Out => ({ cls: 'CONTRADICTORY_EVIDENCE', codes });
const REFUND_FINALITIES: readonly string[] = ['succeeded', 'pending', 'requires_action', 'failed', 'canceled', 'unknown'];
const DISPUTE_OUTCOMES: readonly string[] = ['open', 'won', 'lost', 'unknown'];

const fpEqual = (a: ReadFingerprint, b: ReadFingerprint) => a.paidMinor === b.paidMinor && a.refundCount === b.refundCount && a.disputeCount === b.disputeCount && a.contentDigest === b.contentDigest;
const sameRefund = (a: MockRefund, b: MockRefund) => a.businessId === b.businessId && a.invoiceRef === b.invoiceRef && a.paymentRef === b.paymentRef && a.currency === b.currency && a.amountMinor === b.amountMinor && a.finality === b.finality && a.finalizedAtMs === b.finalizedAtMs;
const sameDispute = (a: MockPaymentDispute, b: MockPaymentDispute) => a.businessId === b.businessId && a.invoiceRef === b.invoiceRef && a.paymentRef === b.paymentRef && a.currency === b.currency && a.amountMinor === b.amountMinor
  && a.outcome === b.outcome && a.closedAtMs === b.closedAtMs && JSON.stringify(a.overlapsRefundIds === null || a.overlapsRefundIds === undefined ? null : [...a.overlapsRefundIds].sort()) === JSON.stringify(b.overlapsRefundIds === null || b.overlapsRefundIds === undefined ? null : [...b.overlapsRefundIds].sort());

function evaluate(ctx: RefundDisputeContext, ev: MockRefundDisputeEvidence): Out {
  const e = ctx.expected;
  const adv: string[] = [];

  // ---- P1: nothing can be concluded about THIS payment from evidence that is not verifiable, in scope, complete and fresh
  if (ev.provenance.providerOutcome !== 'ok') return UNREACH('PROVIDER_UNREACHABLE');
  if (ev.binding.businessId !== e.businessId || ev.refunds.items.some(r => r.businessId !== e.businessId) || ev.disputes.items.some(d => d.businessId !== e.businessId)) return UNREACH('TENANT_MISMATCH');
  const scope: RefundDisputeReason[] = [];
  if (ev.provider.accountId !== e.providerAccountId || ev.provider.mode !== e.providerMode) scope.push('SCOPE_MISMATCH');
  if (ev.payment.invoiceRef !== e.invoiceRef) scope.push('INVOICE_MISMATCH');
  if (ev.payment.ref !== e.paymentRef) scope.push('PAYMENT_MISMATCH');
  if (scope.length) return UNREACH(...new Set(scope));
  if (!isStr(ctx.policy.version)) return UNREACH('POLICY_VERSION_MISSING');
  if (ctx.policy.version !== SUPPORTED_BENEFIT_POLICY_VERSION) return UNREACH('POLICY_VERSION_MISMATCH');
  // Completeness must be EXACTLY the boolean true: a truthy string, number or object ("false", 1, {}) is malformed input, never completeness.
  if (ev.provenance.complete !== true || ev.refunds.complete !== true || ev.disputes.complete !== true) return UNREACH('INCOMPLETE_EVIDENCE');
  if (!isNonNegInt(ctx.policy.freshnessWindowMs)) return UNREACH('FRESHNESS_POLICY_UNAVAILABLE');
  const age = ctx.nowMs - ev.provenance.observedAtMs;
  if (!isInt(ev.provenance.observedAtMs) || age < 0) return UNREACH('EVIDENCE_FROM_FUTURE');
  if (age > ctx.policy.freshnessWindowMs) return UNREACH('STALE_EVIDENCE');

  // ---- P2: parsed evidence that disagrees with itself or with the expected scope
  const { readBefore, readAfter } = ev.provenance;
  if (!readBefore || !readAfter) return UNREACH('INCOMPLETE_EVIDENCE');
  if (!fpEqual(readBefore, readAfter) || readBefore.paidMinor !== ev.payment.paidMinor || readBefore.refundCount !== ev.refunds.items.length || readBefore.disputeCount !== ev.disputes.items.length) return CONTRA('EVIDENCE_UNSTABLE');
  const paid = ev.payment.paidMinor;
  if (ev.payment.currency !== e.currency) return CONTRA('CURRENCY_MISMATCH');
  const c2: RefundDisputeReason[] = [];
  for (const r of ev.refunds.items) {
    if (r.currency !== e.currency) c2.push('CURRENCY_MISMATCH');
    if (r.invoiceRef !== e.invoiceRef) c2.push('INVOICE_MISMATCH');
    if (r.paymentRef !== e.paymentRef) c2.push('PAYMENT_MISMATCH');
    if (r.amountMinor <= 0) c2.push('AMOUNT_INVALID');
    else if (r.amountMinor > paid) c2.push('AMOUNT_EXCEEDS_PAYMENT');
  }
  for (const d of ev.disputes.items) {
    if (d.currency !== e.currency) c2.push('CURRENCY_MISMATCH');
    if (d.invoiceRef !== e.invoiceRef) c2.push('INVOICE_MISMATCH');
    if (d.paymentRef !== e.paymentRef) c2.push('PAYMENT_MISMATCH');
    if (d.amountMinor <= 0) c2.push('AMOUNT_INVALID');
    else if (d.amountMinor > paid) c2.push('AMOUNT_EXCEEDS_PAYMENT');
  }
  if (c2.length) return CONTRA(...new Set(c2));
  // duplicates: identical repeats are one observation; any difference under one id is a conflict
  const refunds = new Map<string, MockRefund>(); const disputes = new Map<string, MockPaymentDispute>();
  let dup = false;
  for (const r of ev.refunds.items) { const x = refunds.get(r.id); if (!x) refunds.set(r.id, r); else if (!sameRefund(x, r)) return CONTRA('DUPLICATE_CONFLICT'); else dup = true; }
  for (const d of ev.disputes.items) { const x = disputes.get(d.id); if (!x) disputes.set(d.id, d); else if (!sameDispute(x, d)) return CONTRA('DUPLICATE_CONFLICT'); else dup = true; }
  if (dup) adv.push('DUPLICATE_OBSERVATION_IGNORED');
  const R = [...refunds.values()]; const D = [...disputes.values()];
  const refundRefs = R.map(r => r.id).sort(); const disputeRefs = D.map(d => d.id).sort();
  if (D.length > 1) return { ...CONTRA('MULTIPLE_DISPUTES_UNDEFINED'), refunds: refundRefs, disputes: disputeRefs }; // the specification does not say how several disputes on one payment combine

  // ---- P3: an open (or unknown) dispute can still change the amount at stake and dominates refund finality
  const dispute = D[0];
  if (dispute && dispute.outcome !== 'won' && dispute.outcome !== 'lost') {
    return { cls: 'DISPUTE_OPEN', codes: [dispute.outcome === 'open' ? 'DISPUTE_OPEN' : 'DISPUTE_OUTCOME_UNKNOWN'], advisories: adv, refunds: refundRefs, disputes: disputeRefs };
  }
  // ---- P4: a refund that is not a final success is not a final loss, and not "no refund"
  const notFinal = R.filter(r => r.finality !== 'succeeded');
  if (notFinal.length) {
    const codes: RefundDisputeReason[] = [];
    if (notFinal.some(r => r.finality === 'unknown')) codes.push('REFUND_FINALITY_UNKNOWN');
    if (notFinal.some(r => r.finality === 'pending' || r.finality === 'requires_action')) codes.push('REFUND_PENDING');
    if (notFinal.some(r => r.finality === 'failed' || r.finality === 'canceled')) codes.push('REFUND_NOT_SUCCEEDED');
    return { cls: 'REFUND_PENDING', codes, advisories: adv, refunds: refundRefs, disputes: disputeRefs };
  }

  // ---- P5: verified final loss, each unit of loss counted once
  const settled = R; // all remaining refunds are succeeded
  const refundSum = settled.reduce((n, r) => n + r.amountMinor, 0);
  // No separate unsafe-sum check: every amount is a safe integer no larger than the payment, so a sum that overflows the safe range is also larger than the payment and is rejected here.
  if (refundSum > paid) return { ...CONTRA('LOSS_EXCEEDS_PAYMENT'), refunds: refundRefs, disputes: disputeRefs };
  const times = (xs: Array<number | null>) => xs.filter((t): t is number => isNonNegInt(t));
  const lost = dispute && dispute.outcome === 'lost' ? dispute : null;
  let loss = refundSum; let lossTimes = times(settled.map(r => r.finalizedAtMs));
  if (lost) {
    if (settled.length > 0) {
      if (lost.overlapsRefundIds === null || lost.overlapsRefundIds === undefined || !Array.isArray(lost.overlapsRefundIds)) return { ...CONTRA('LOSS_OVERLAP_UNDEFINED'), refunds: refundRefs, disputes: disputeRefs };
      const ids = new Set(lost.overlapsRefundIds);
      if (ids.size !== lost.overlapsRefundIds.length || [...ids].some(id => !refunds.has(id))) return { ...CONTRA('OVERLAP_REFERENCE_UNKNOWN'), refunds: refundRefs, disputes: disputeRefs };
      const same = settled.filter(r => ids.has(r.id));
      const sameSum = same.reduce((n, r) => n + r.amountMinor, 0);
      if (same.length > 0 && sameSum !== lost.amountMinor) return { ...CONTRA('OVERLAP_AMOUNT_CONFLICT'), refunds: refundRefs, disputes: disputeRefs };
      loss = lost.amountMinor + (refundSum - sameSum); // the stated same-loss refunds are the dispute loss itself: counted once
    } else loss = lost.amountMinor;
    lossTimes = [...lossTimes, ...times([lost.closedAtMs])];
    if (loss > paid) return { ...CONTRA('LOSS_EXCEEDS_PAYMENT'), refunds: refundRefs, disputes: disputeRefs };
  }
  if (loss > 0) {
    const full = loss === paid;
    const cls: RefundDisputeClass = lost ? 'DISPUTE_LOST_VERIFIED' : full ? 'FULL_REFUND_VERIFIED' : 'PARTIAL_REFUND_VERIFIED';
    const code: RefundDisputeReason = !full ? 'PARTIAL_LOSS_VERIFIED' : lost ? 'DISPUTE_LOST_VERIFIED' : 'FULL_REFUND_VERIFIED';
    if (full) adv.push('RECOVERY_APPROVAL_MODEL_UNDECIDED');
    return { cls, codes: [code], lossMinor: loss, extent: full ? 'full' : 'partial', lossTimes, advisories: adv, refunds: refundRefs, disputes: disputeRefs };
  }
  // ---- P6 / P7: no loss
  if (dispute && dispute.outcome === 'won') return { cls: 'DISPUTE_WON_VERIFIED', codes: ['DISPUTE_WON_VERIFIED'], lossMinor: 0, extent: 'none', advisories: [...adv, 'DISPUTE_WON_DOES_NOT_REVERSE_CONSUMPTION'], refunds: refundRefs, disputes: disputeRefs };
  return { cls: 'NO_REFUND', codes: ['NO_REFUND_OR_DISPUTE_VERIFIED'], lossMinor: 0, extent: 'none', advisories: adv, refunds: refundRefs, disputes: disputeRefs };
}

export function classifyRefundDispute(ctx: RefundDisputeContext, evidence: MockRefundDisputeEvidence | null | undefined): RefundDisputeClassification {
  const nowOk = isNonNegInt(ctx?.nowMs);
  let out: Out;
  try {
    const arrays = (a: unknown) => Array.isArray(a);
    const validRefund = (r: MockRefund) => isStr(r?.id) && isStr(r.businessId) && isStr(r.invoiceRef) && isStr(r.paymentRef) && isStr(r.currency) && isInt(r.amountMinor) && REFUND_FINALITIES.includes(r.finality) && (r.finalizedAtMs === null || isNonNegInt(r.finalizedAtMs));
    const validDispute = (d: MockPaymentDispute) => isStr(d?.id) && isStr(d.businessId) && isStr(d.invoiceRef) && isStr(d.paymentRef) && isStr(d.currency) && isInt(d.amountMinor) && DISPUTE_OUTCOMES.includes(d.outcome)
      && (d.closedAtMs === null || isNonNegInt(d.closedAtMs)) && (d.overlapsRefundIds === null || d.overlapsRefundIds === undefined || (Array.isArray(d.overlapsRefundIds) && d.overlapsRefundIds.every(isStr)));
    const validFp = (f: ReadFingerprint | null) => f === null || (isNonNegInt(f?.paidMinor) && isNonNegInt(f.refundCount) && isNonNegInt(f.disputeCount) && DIGEST.test(String(f.contentDigest)));
    if (!ctx || !nowOk || !ctx.policy || !ctx.expected) out = UNREACH('INPUT_INVALID');
    else if (!evidence) out = UNREACH('EVIDENCE_MISSING');
    else if (assertsAuthority(evidence) || assertsAuthority(ctx)) out = UNREACH('CALLER_AUTHORITY_ASSERTED');
    else if (!evidence.provenance || !evidence.binding || !evidence.provider || !evidence.payment || !evidence.refunds || !evidence.disputes || !arrays(evidence.refunds.items) || !arrays(evidence.disputes.items)) out = UNREACH('EVIDENCE_MISSING');
    else if (evidence.provenance.evidenceKind !== MOCK_EVIDENCE_KIND) out = UNREACH('EVIDENCE_KIND_UNSUPPORTED');
    else if (evidence.provenance.origin !== EVIDENCE_ORIGIN) out = UNREACH('EVIDENCE_ORIGIN_UNTRUSTED');
    else if (!isStr(evidence.provenance.snapshotRef) || !DIGEST.test(String(evidence.provenance.snapshotDigest)) || !validFp(evidence.provenance.readBefore) || !validFp(evidence.provenance.readAfter)
      || !isStr(evidence.payment.ref) || !isStr(evidence.payment.invoiceRef) || !isStr(evidence.payment.currency) || !isInt(evidence.payment.paidMinor) || evidence.payment.paidMinor <= 0
      || !isStr(evidence.binding.businessId) || !isStr(evidence.provider.accountId) || !['test', 'live'].includes(evidence.provider.mode)
      || !evidence.refunds.items.every(validRefund) || !evidence.disputes.items.every(validDispute)) out = UNREACH('INPUT_INVALID');
    else out = evaluate(ctx, evidence);
  } catch {
    out = UNREACH('INPUT_INVALID'); // malformed input never throws and never classifies as a verified outcome; no error text is returned
  }
  const codes = [...new Set(out.codes)];
  const cls = out.cls;
  const verified = cls === 'NO_REFUND' || cls === 'FULL_REFUND_VERIFIED' || cls === 'PARTIAL_REFUND_VERIFIED' || cls === 'DISPUTE_LOST_VERIFIED' || cls === 'DISPUTE_WON_VERIFIED';
  const full = (cls === 'FULL_REFUND_VERIFIED' || cls === 'DISPUTE_LOST_VERIFIED') && out.extent === 'full';
  const consumedAt = ctx?.expected?.consumedAtMs;
  const firstLoss = out.lossTimes && out.lossTimes.length ? Math.min(...out.lossTimes) : null;
  const relative: 'before' | 'after' | 'unknown' = isNonNegInt(consumedAt) && firstLoss !== null && (cls === 'FULL_REFUND_VERIFIED' || cls === 'PARTIAL_REFUND_VERIFIED' || cls === 'DISPUTE_LOST_VERIFIED') ? (firstLoss < consumedAt ? 'before' : 'after') : 'unknown';
  const ev = evidence ?? null;
  const exp = ctx?.expected;
  const extent: Extent = out.extent ?? (verified ? 'none' : 'unknown');
  return {
    classifierVersion: REFUND_DISPUTE_CLASSIFIER_VERSION,
    decisionRecord: DECISION_RECORD,
    classification: cls,
    reasonCodes: codes,
    advisories: [...new Set(out.advisories ?? [])],
    evidenceRefs: {
      snapshotRef: safeRef(ev?.provenance?.snapshotRef), snapshotDigest: DIGEST.test(String(ev?.provenance?.snapshotDigest)) ? ev!.provenance.snapshotDigest : null,
      refundRefs: (out.refunds ?? []).map(safeRef).filter((x): x is string => x !== null), disputeRefs: (out.disputes ?? []).map(safeRef).filter((x): x is string => x !== null),
    },
    evaluated: { businessId: safeRef(exp?.businessId), invoiceRef: safeRef(exp?.invoiceRef), paymentRef: safeRef(exp?.paymentRef), currency: safeRef(exp?.currency), providerAccountId: safeRef(exp?.providerAccountId), providerMode: exp?.providerMode === 'test' || exp?.providerMode === 'live' ? exp.providerMode : null },
    amounts: { paidMinor: verified && isInt(ev?.payment?.paidMinor) ? ev!.payment.paidMinor : null, lossMinor: verified ? (out.lossMinor ?? 0) : null, extent },
    relativeToConsumption: relative,
    outstandingUncertainties: [...new Set(codes.map(c => REQUIREMENT[c]).filter((r): r is string => !!r))],
    manualReviewRequired: cls === 'PARTIAL_REFUND_VERIFIED' || cls === 'DISPUTE_OPEN' || cls === 'CONTRADICTORY_EVIDENCE' || (cls === 'PROVIDER_UNREACHABLE' && codes.some(c => MANUAL.has(c))) || (cls === 'DISPUTE_LOST_VERIFIED' && out.extent === 'partial'),
    requiresReconciliation: !(cls === 'NO_REFUND' || cls === 'FULL_REFUND_VERIFIED' || cls === 'DISPUTE_WON_VERIFIED' || (cls === 'DISPUTE_LOST_VERIFIED' && out.extent === 'full')),
    mayQualifyForFutureRecoveryReview: full,
    policyVersion: safeRef(ctx?.policy?.version),
    evaluatedAt: nowOk ? new Date(ctx.nowMs).toISOString() : new Date(0).toISOString(),
    grantsFinancialAuthority: false,
  };
}
