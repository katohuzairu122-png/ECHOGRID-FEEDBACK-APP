import type { FrozenAggregateBenefitAllocation } from './aggregate-benefit-allocation';

/**
 * S08-D1D3-DEV-01: PURE settlement eligibility classifier (design: docs/architecture/builds/SPLIT-08/S08_D1D3_SETTLEMENT_ELIGIBILITY_SPEC.md, owner decision S08-D1D3/1).
 *
 * It answers one question: do these independently verified, SYNTHETIC mock evidence facts support a future consumption decision? It is CLASSIFICATION AUTHORITY only.
 * It reads no database, calls no provider, holds no clock, mutates nothing and returns no provider payload. `ELIGIBLE` is not permission to consume, release or
 * write anything: the accounting authority (the existing transactional consumption) and the execution authority are separate and are not touched here.
 *
 * Inert by construction: there is no production caller. The evidence type is deliberately branded `MOCK_SYNTHETIC`; it is not a real verifier capability and
 * the classifier refuses any other kind until a real verified-evidence envelope is separately specified and authorized.
 *
 * Fail closed: every missing, malformed, stale, unstable, contradictory, wrongly scoped or policy-dependent fact is UNRESOLVED. INELIGIBLE needs complete, stable,
 * in-scope evidence that conclusively shows a disqualifying fact, and is only ever "as of this snapshot".
 */
export const SETTLEMENT_CLASSIFIER_VERSION = 'S08-D1D3-SETTLEMENT/1' as const;
export const SUPPORTED_BENEFIT_POLICY_VERSION = 'PC-BENEFIT/1' as const;
export const SUPPORTED_ALLOCATION_POLICY_VERSION = 'S08-AGG-ROUND/1' as const;
export const MOCK_EVIDENCE_KIND = 'MOCK_SYNTHETIC' as const;
export const benefitIdempotencyKey = (reservationId: string) => `benefit-apply:v1:${reservationId}`;

export type SettlementVerdict = 'ELIGIBLE' | 'INELIGIBLE' | 'UNRESOLVED';
export type ProviderMode = 'test' | 'live';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export type LineCategory = 'recurring_base' | 'proration' | 'tax' | 'benefit' | 'other';

/** Trusted inputs: configuration and tenant-checked persisted records. Never taken from the provider response or a caller assertion. */
export interface SettlementClassifierContext {
  readonly nowMs: number;
  readonly policy: Readonly<{
    version: string | null;
    /** Instant from which PC-BENEFIT/1 applies to invoices (prospective effect, D1-c). Not hardcoded: the exact instant is a recorded-policy dependency. */
    effectiveFromMs: number | null;
    /** Freshness window F. UNDECIDED by the owner (OQ-7): when absent the classifier can never return ELIGIBLE. */
    freshnessWindowMs: number | null;
  }>;
  readonly expected: Readonly<{
    businessId: string;
    reservationId: string;
    intentRef: string;
    invoiceRef: string;
    customerRef: string;
    subscriptionRef: string;
    currency: string;
    providerAccountId: string;
    providerMode: ProviderMode;
    reservationExpiresAtMs: number | null;
    frozenAllocation: FrozenAggregateBenefitAllocation;
  }>;
}

export interface MockInvoiceLine {
  readonly lineRef: string;
  /** Net line amount in integer minor units (negative for the benefit). */
  readonly amountMinor: number;
  readonly currency: string;
  readonly category: LineCategory;
  /** Provider-reported parent Invoice Item of this line (the correlation that must hold). */
  readonly parentItemRef: string | null;
  /** Provider-reported idempotency key of the parent item. */
  readonly parentItemKey: string | null;
  /** Untrusted metadata label. Never sufficient for attribution. */
  readonly labelReservationRef: string | null;
}

export interface MockBenefitItem {
  readonly itemRef: string;
  readonly invoiceRef: string;
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly discountable: boolean;
}

export type RefundEvidence = 'none' | 'pending' | 'partial' | 'full' | 'unknown';
export type DisputeEvidence = 'none' | 'open' | 'lost' | 'won' | 'unknown';
export type CancellationEvidence = 'none' | 'canceled_before_payment' | 'canceled_after_payment' | 'unknown';
export type SettlementSource = 'stripe_payment' | 'out_of_band' | 'unknown';
export type ProviderOutcome = 'ok' | 'unreachable' | 'rate_limited' | 'permanent_error';

export interface ReadFingerprint {
  readonly status: string;
  readonly amountDueMinor: number;
  readonly amountPaidMinor: number;
  readonly amountRemainingMinor: number;
  readonly totalMinor: number;
  readonly lineCount: number;
}

/** Synthetic, already-verified mock evidence. It cannot carry any financial permission: unknown authority-bearing keys are rejected at runtime. */
export interface MockSettlementEvidence {
  readonly provenance: Readonly<{
    evidenceKind: typeof MOCK_EVIDENCE_KIND;
    snapshotRef: string;
    snapshotDigest: string;
    observedAtMs: number;
    providerOutcome: ProviderOutcome;
    complete: boolean;
    readBefore: ReadFingerprint | null;
    readAfter: ReadFingerprint | null;
  }>;
  readonly binding: Readonly<{ businessId: string; reservationId: string; intentRef: string }>;
  readonly provider: Readonly<{ accountId: string; mode: ProviderMode }>;
  readonly invoice: Readonly<{
    id: string; customerRef: string; subscriptionRef: string; currency: string; status: string;
    amountDueMinor: number; amountPaidMinor: number; amountRemainingMinor: number; totalMinor: number;
    createdAtMs: number; paidAtMs: number | null; voidedAtMs: number | null; billingInterval: 'month' | 'year' | 'unknown';
  }>;
  readonly lines: Readonly<{ complete: boolean; items: readonly MockInvoiceLine[] }>;
  readonly benefitItem: MockBenefitItem | null;
  readonly settlement: Readonly<{ source: SettlementSource; paymentRef: string | null }>;
  readonly events: Readonly<{ refund: RefundEvidence; dispute: DisputeEvidence; cancellation: CancellationEvidence }>;
}

export type SettlementReason =
  | 'ALL_CONDITIONS_VERIFIED'
  | 'INPUT_INVALID' | 'EVIDENCE_MISSING' | 'EVIDENCE_KIND_UNSUPPORTED' | 'CALLER_AUTHORITY_ASSERTED'
  | 'TENANT_MISMATCH' | 'RESERVATION_MISMATCH' | 'FROZEN_ALLOCATION_MISMATCH'
  | 'PROVIDER_UNREACHABLE' | 'SCOPE_MISMATCH' | 'CURRENCY_MISMATCH'
  | 'POLICY_VERSION_MISSING' | 'POLICY_VERSION_MISMATCH' | 'POLICY_EFFECTIVE_DATE_UNAVAILABLE' | 'POLICY_NOT_EFFECTIVE'
  | 'INCOMPLETE_EVIDENCE' | 'EVIDENCE_UNSTABLE' | 'AMOUNTS_INCONSISTENT' | 'DUPLICATE_LINE'
  | 'INVOICE_VOID' | 'INVOICE_UNCOLLECTIBLE' | 'NOT_SETTLED' | 'PARTIAL_PAYMENT' | 'STATUS_UNKNOWN' | 'PAID_WITH_REMAINING' | 'CONTRADICTORY_EVIDENCE'
  | 'OUT_OF_BAND' | 'SETTLEMENT_SOURCE_UNKNOWN' | 'SETTLEMENT_TIME_MISSING' | 'NO_ECONOMIC_BENEFIT'
  | 'REFUND_PENDING' | 'REFUND_PARTIAL' | 'REFUNDED' | 'REFUND_EVIDENCE_UNKNOWN'
  | 'DISPUTE_OPEN' | 'PAYMENT_DISPUTE_LOST' | 'DISPUTE_EVIDENCE_UNKNOWN' | 'CANCELLATION_EVIDENCE_UNKNOWN'
  | 'BENEFIT_LINE_MISSING' | 'ATTRIBUTION_MISMATCH' | 'AMOUNT_MISMATCH' | 'DUPLICATE_EFFECT' | 'UNEXPECTED_BENEFIT_LINE' | 'BENEFIT_DISCOUNTABLE'
  | 'EVIDENCE_DRIFT' | 'PRORATION_ONLY_BASE'
  | 'RESERVATION_EXPIRY_UNKNOWN' | 'SETTLED_AFTER_EXPIRY'
  | 'FRESHNESS_POLICY_UNAVAILABLE' | 'STALE_EVIDENCE' | 'EVIDENCE_FROM_FUTURE';

export interface SettlementClassification {
  readonly classifierVersion: typeof SETTLEMENT_CLASSIFIER_VERSION;
  readonly verdict: SettlementVerdict;
  readonly reasonCodes: readonly SettlementReason[];
  readonly advisories: readonly string[];
  /** What would have to be established for the verdict to change; empty for ELIGIBLE. */
  readonly unresolvedRequirements: readonly string[];
  readonly evidenceRefs: Readonly<{ snapshotRef: string | null; snapshotDigest: string | null; invoiceRef: string | null; benefitItemRef: string | null; paymentRef: string | null; allocationDigest: string | null }>;
  readonly policyVersion: string | null;
  readonly evaluatedAt: string;
  readonly manualReviewRequired: boolean;
  /** The classifier never releases a reservation. */
  readonly reservationHeld: true;
  /** The classifier grants no financial authority. */
  readonly grantsFinancialAuthority: false;
}

const MANUAL_REVIEW: ReadonlySet<SettlementReason> = new Set<SettlementReason>([
  'TENANT_MISMATCH', 'RESERVATION_MISMATCH', 'FROZEN_ALLOCATION_MISMATCH', 'SCOPE_MISMATCH', 'CALLER_AUTHORITY_ASSERTED', 'EVIDENCE_KIND_UNSUPPORTED',
  'OUT_OF_BAND', 'INVOICE_UNCOLLECTIBLE', 'INVOICE_VOID', 'NO_ECONOMIC_BENEFIT', 'CONTRADICTORY_EVIDENCE', 'ATTRIBUTION_MISMATCH', 'DUPLICATE_EFFECT',
  'UNEXPECTED_BENEFIT_LINE', 'AMOUNT_MISMATCH', 'EVIDENCE_DRIFT', 'PRORATION_ONLY_BASE', 'SETTLED_AFTER_EXPIRY', 'DISPUTE_OPEN', 'PAYMENT_DISPUTE_LOST',
  'REFUND_PARTIAL', 'REFUNDED', 'SETTLEMENT_SOURCE_UNKNOWN', 'AMOUNTS_INCONSISTENT', 'PAID_WITH_REMAINING', 'DUPLICATE_LINE', 'BENEFIT_DISCOUNTABLE',
]);

const REQUIREMENT: Readonly<Partial<Record<SettlementReason, string>>> = {
  PROVIDER_UNREACHABLE: 'a complete independent provider read', INCOMPLETE_EVIDENCE: 'complete evidence (all pages read)', EVIDENCE_UNSTABLE: 'two equal bracketing reads',
  STALE_EVIDENCE: 'a fresh observation', FRESHNESS_POLICY_UNAVAILABLE: 'an owner-approved freshness window (OQ-7)', POLICY_EFFECTIVE_DATE_UNAVAILABLE: 'the recorded policy effective instant',
  POLICY_VERSION_MISSING: 'a policy version', POLICY_VERSION_MISMATCH: 'matching policy versions', NOT_SETTLED: 'invoice status paid', PARTIAL_PAYMENT: 'full payment',
  SETTLED_AFTER_EXPIRY: 'an owner decision on settlement after reservation expiry (OQ-3)', RESERVATION_EXPIRY_UNKNOWN: 'the reservation expiry', SCOPE_MISMATCH: 'evidence from the configured account and mode',
  ATTRIBUTION_MISMATCH: 'item-to-line correlation proven by the provider', BENEFIT_LINE_MISSING: 'the verified benefit line', DISPUTE_OPEN: 'a final dispute outcome', REFUND_PENDING: 'a final refund state',
  REFUND_PARTIAL: 'a separate owner-approved partial-refund policy (OQ-11)', SETTLEMENT_SOURCE_UNKNOWN: 'the settlement source (OQ-1)', EVIDENCE_DRIFT: 'owner review of post-freeze invoice change',
  PRORATION_ONLY_BASE: 'owner review (proration excluded from the base)', CONTRADICTORY_EVIDENCE: 'consistent provider evidence', TENANT_MISMATCH: 'tenant-matching evidence',
  RESERVATION_MISMATCH: 'reservation-matching evidence', FROZEN_ALLOCATION_MISMATCH: 'a valid frozen allocation', EVIDENCE_MISSING: 'the missing evidence section', INPUT_INVALID: 'well-formed evidence',
};

type Out = { verdict: SettlementVerdict; codes: SettlementReason[] };
export const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
export const isNonNegInt = (n: unknown): n is number => isInt(n) && n >= 0;
export const isStr = (s: unknown): s is string => typeof s === 'string' && s.length > 0;
export const SAFE_REF = /^[A-Za-z0-9_:./-]{1,128}$/;
export const safeRef = (s: unknown): string | null => (typeof s === 'string' && SAFE_REF.test(s) ? s : null);
export const DIGEST = /^[0-9a-f]{64}$/;
/** Keys that would let a caller assert financial authority. Any truthy occurrence anywhere in the input is refused. */
const AUTHORITY_KEYS: ReadonlySet<string> = new Set(['consumptionauthorized', 'providerverified', 'settlementauthorized', 'financialauthority', 'authorized', 'trusted', 'verified', 'eligible', 'approved']); // compared lower-case

export function assertsAuthority(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => assertsAuthority(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (AUTHORITY_KEYS.has(k.toLowerCase()) && v !== false && v !== undefined && v !== null) {
      // the frozen allocation legitimately carries the literal `false` flags; anything else (true, strings, numbers) is an assertion
      return true;
    }
    if (assertsAuthority(v, depth + 1)) return true;
  }
  return false;
}

const fingerprintEqual = (a: ReadFingerprint, b: ReadFingerprint) =>
  a.status === b.status && a.amountDueMinor === b.amountDueMinor && a.amountPaidMinor === b.amountPaidMinor && a.amountRemainingMinor === b.amountRemainingMinor &&
  a.totalMinor === b.totalMinor && a.lineCount === b.lineCount;

/**
 * Evaluation is a fixed sequence of phases. A phase that finds anything returns immediately with every code it found, so later (less trustworthy) checks never
 * run on evidence an earlier phase already rejected, and INELIGIBLE can only come from phases that run after the trust phases passed.
 */
function evaluate(ctx: SettlementClassifierContext, ev: MockSettlementEvidence, advisories: string[]): Out {
  const out = (verdict: SettlementVerdict, ...codes: SettlementReason[]): Out => ({ verdict, codes });
  const U = (...c: SettlementReason[]) => out('UNRESOLVED', ...c);
  const e = ctx.expected;
  const frozen = e.frozenAllocation;
  const ourKey = benefitIdempotencyKey(e.reservationId);

  // P1: tenant, reservation, intent and the frozen allocation the evidence must belong to
  if (ev.binding.businessId !== e.businessId) return U('TENANT_MISMATCH');
  if (ev.binding.reservationId !== e.reservationId || ev.binding.intentRef !== e.intentRef) return U('RESERVATION_MISMATCH');
  const own = frozen.allocations.find(a => a.reservationId === e.reservationId);
  const sum = frozen.allocations.reduce((n, a) => n + a.benefitMinor, 0);
  if (frozen.businessId !== e.businessId || frozen.invoiceRef !== e.invoiceRef || frozen.currency !== e.currency || frozen.allocationPolicyVersion !== SUPPORTED_ALLOCATION_POLICY_VERSION ||
      frozen.providerVerified !== false || frozen.consumptionAuthorized !== false || !own || own.providerIdempotencyKey !== ourKey || own.invoiceIntentRef !== e.intentRef ||
      !isInt(own.benefitMinor) || own.benefitMinor <= 0 || sum !== frozen.aggregateBenefitMinor || !isNonNegInt(frozen.eligibleBaseMinor) || !isStr(frozen.allocationDigest))
    return U('FROZEN_ALLOCATION_MISMATCH');

  // P2: provider outcome
  if (ev.provenance.providerOutcome !== 'ok') return U('PROVIDER_UNREACHABLE');

  // P3: provider identity, mode, invoice identity and currency, taken from configuration and persisted records, never from the response
  const scope: SettlementReason[] = [];
  if (ev.provider.accountId !== e.providerAccountId) scope.push('SCOPE_MISMATCH');
  if (ev.provider.mode !== e.providerMode) scope.push('SCOPE_MISMATCH');
  if (ev.invoice.id !== e.invoiceRef || ev.invoice.customerRef !== e.customerRef || ev.invoice.subscriptionRef !== e.subscriptionRef) scope.push('SCOPE_MISMATCH');
  if (ev.invoice.currency !== e.currency) scope.push('CURRENCY_MISMATCH');
  if (scope.length) return U(...new Set(scope));

  // P4: policy version (a recorded-policy dependency; absent or different is never guessed)
  if (!isStr(ctx.policy.version) || !isStr(frozen.benefitPolicyVersion)) return U('POLICY_VERSION_MISSING');
  if (ctx.policy.version !== SUPPORTED_BENEFIT_POLICY_VERSION || frozen.benefitPolicyVersion !== ctx.policy.version) return U('POLICY_VERSION_MISMATCH');
  if (!isNonNegInt(ctx.policy.effectiveFromMs)) return U('POLICY_EFFECTIVE_DATE_UNAVAILABLE');

  // P5: completeness
  // Completeness must be EXACTLY the boolean true: a truthy string, number or object ("false", 1, {}) is malformed input, never completeness.
  if (ev.provenance.complete !== true || ev.lines.complete !== true) return U('INCOMPLETE_EVIDENCE');

  // P6: stability across the bracketing reads
  const { readBefore, readAfter } = ev.provenance;
  if (!readBefore || !readAfter) return U('INCOMPLETE_EVIDENCE');
  if (!fingerprintEqual(readBefore, readAfter)) return U('EVIDENCE_UNSTABLE');
  const inv = ev.invoice;
  if (readBefore.status !== inv.status || readBefore.amountDueMinor !== inv.amountDueMinor || readBefore.amountPaidMinor !== inv.amountPaidMinor ||
      readBefore.amountRemainingMinor !== inv.amountRemainingMinor || readBefore.totalMinor !== inv.totalMinor || readBefore.lineCount !== ev.lines.items.length) return U('EVIDENCE_UNSTABLE');

  // P7: arithmetic coherence and duplicate lines
  const items = ev.lines.items;
  // a non-integer timestamp would make `createdAt < effectiveFrom` false and silently skip the policy-applicability rule, so it is refused here
  if (!isNonNegInt(inv.createdAtMs)) return U('INPUT_INVALID');
  if (new Set(items.map(l => l.lineRef)).size !== items.length) return U('DUPLICATE_LINE');
  if (![inv.amountDueMinor, inv.amountPaidMinor, inv.amountRemainingMinor].every(isNonNegInt) || !isInt(inv.totalMinor) || inv.totalMinor < 0 ||
      inv.amountPaidMinor + inv.amountRemainingMinor !== inv.amountDueMinor || items.some(l => !isInt(l.amountMinor)) ||
      items.reduce((n, l) => n + l.amountMinor, 0) !== inv.totalMinor) return U('AMOUNTS_INCONSISTENT');

  // P8: invoice state, settlement source and policy applicability (the only phase that can disqualify)
  if (inv.status === 'void') return inv.paidAtMs != null ? U('CONTRADICTORY_EVIDENCE') : out('INELIGIBLE', 'INVOICE_VOID');
  if (inv.status === 'uncollectible') return out('INELIGIBLE', 'INVOICE_UNCOLLECTIBLE');
  if (inv.status === 'draft' || inv.status === 'open') return U(inv.amountPaidMinor > 0 && inv.amountRemainingMinor > 0 ? 'PARTIAL_PAYMENT' : 'NOT_SETTLED');
  if (inv.status !== 'paid') return U('STATUS_UNKNOWN');
  if (inv.voidedAtMs != null) return U('CONTRADICTORY_EVIDENCE');
  if (inv.amountRemainingMinor !== 0) return U('PAID_WITH_REMAINING');
  if (ev.settlement.source === 'unknown') return U('SETTLEMENT_SOURCE_UNKNOWN');
  if (ev.settlement.source === 'out_of_band') return out('INELIGIBLE', 'OUT_OF_BAND');
  if (ev.settlement.source !== 'stripe_payment' || !isStr(ev.settlement.paymentRef)) return U('SETTLEMENT_SOURCE_UNKNOWN');
  if (inv.createdAtMs < (ctx.policy.effectiveFromMs as number)) return out('INELIGIBLE', 'POLICY_NOT_EFFECTIVE');
  const preBenefit = items.filter(l => l.category !== 'benefit').reduce((n, l) => n + l.amountMinor, 0);
  if (inv.totalMinor === 0 && preBenefit <= 0) return out('INELIGIBLE', 'NO_ECONOMIC_BENEFIT');

  // P9: contradictory refund, dispute and cancellation evidence
  const { refund, dispute, cancellation } = ev.events;
  const c9: SettlementReason[] = [];
  if (!['none', 'pending', 'partial', 'full'].includes(refund)) c9.push('REFUND_EVIDENCE_UNKNOWN');
  if (!['none', 'open', 'lost', 'won'].includes(dispute)) c9.push('DISPUTE_EVIDENCE_UNKNOWN');
  if (!['none', 'canceled_before_payment', 'canceled_after_payment'].includes(cancellation)) c9.push('CANCELLATION_EVIDENCE_UNKNOWN');
  if (cancellation === 'canceled_before_payment') c9.push('CONTRADICTORY_EVIDENCE');
  if (dispute === 'open') c9.push('DISPUTE_OPEN');
  if (refund === 'pending') c9.push('REFUND_PENDING');
  if (refund === 'partial') c9.push('REFUND_PARTIAL');
  if (c9.length) return U(...new Set(c9));
  if (refund === 'full') return out('INELIGIBLE', 'REFUNDED');
  if (dispute === 'lost') return out('INELIGIBLE', 'PAYMENT_DISPUTE_LOST');

  // P10: the benefit line, its correlation, amount, currency, discountability, the frozen base and unexpected benefit lines
  const benefitLines = items.filter(l => l.category === 'benefit');
  const ours = benefitLines.filter(l => l.parentItemKey === ourKey);
  if (ours.length > 1) return U('DUPLICATE_EFFECT');
  const foreign = benefitLines.filter(l => l.parentItemKey !== ourKey);
  const allowed = new Map(frozen.allocations.map(a => [a.providerIdempotencyKey, a.benefitMinor] as const));
  if (foreign.some(l => !isStr(l.parentItemKey) || !allowed.has(l.parentItemKey) || l.amountMinor !== -(allowed.get(l.parentItemKey) as number))) return U('UNEXPECTED_BENEFIT_LINE');
  if (new Set(foreign.map(l => l.parentItemKey)).size !== foreign.length) return U('DUPLICATE_EFFECT');
  const item = ev.benefitItem;
  const line = ours[0];
  if (!item || !line) return U('BENEFIT_LINE_MISSING');
  const c10: SettlementReason[] = [];
  if (item.invoiceRef !== e.invoiceRef || item.idempotencyKey !== ourKey || line.parentItemRef !== item.itemRef) c10.push('ATTRIBUTION_MISMATCH');
  if (item.currency !== e.currency || line.currency !== e.currency) c10.push('CURRENCY_MISMATCH');
  if (item.amountMinor !== -(own.benefitMinor) || line.amountMinor !== -(own.benefitMinor)) c10.push('AMOUNT_MISMATCH');
  if (item.discountable !== false) c10.push('BENEFIT_DISCOUNTABLE');
  if (c10.length) return U(...new Set(c10));
  // No separate cap check is needed: every benefit line is pinned to exactly one frozen allocation by key and amount, and P1 proved the allocations sum to the frozen aggregate.
  const base = items.filter(l => l.category === 'recurring_base');
  const baseSum = base.reduce((n, l) => n + l.amountMinor, 0);
  if (base.length === 0 && items.some(l => l.category === 'proration')) return U('PRORATION_ONLY_BASE');
  if (baseSum !== frozen.eligibleBaseMinor) return U('EVIDENCE_DRIFT');

  // P11: timing and freshness (the settlement must predate the reservation expiry; the evidence must be fresh under an owner-approved window)
  if (!isNonNegInt(e.reservationExpiresAtMs)) return U('RESERVATION_EXPIRY_UNKNOWN');
  if (!isNonNegInt(inv.paidAtMs)) return U('SETTLEMENT_TIME_MISSING');
  if (inv.paidAtMs >= e.reservationExpiresAtMs) return U('SETTLED_AFTER_EXPIRY'); // same boundary the reservation uses: expired when expires_at <= now
  if (!isNonNegInt(ctx.policy.freshnessWindowMs)) return U('FRESHNESS_POLICY_UNAVAILABLE');
  const age = ctx.nowMs - ev.provenance.observedAtMs;
  if (!isInt(ev.provenance.observedAtMs) || age < 0) return U('EVIDENCE_FROM_FUTURE');
  if (age > ctx.policy.freshnessWindowMs) return U('STALE_EVIDENCE');

  if (inv.billingInterval === 'year') advisories.push('INTERVAL_FROZEN_NOT_REEVALUATED');
  return out('ELIGIBLE', 'ALL_CONDITIONS_VERIFIED');
}

export function classifySettlement(ctx: SettlementClassifierContext, evidence: MockSettlementEvidence | null | undefined): SettlementClassification {
  const advisories: string[] = [];
  const nowOk = isNonNegInt(ctx?.nowMs);
  let result: Out;
  try {
    if (!ctx || !nowOk || !ctx.policy || !ctx.expected || !ctx.expected.frozenAllocation) result = { verdict: 'UNRESOLVED', codes: ['INPUT_INVALID'] };
    else if (!evidence) result = { verdict: 'UNRESOLVED', codes: ['EVIDENCE_MISSING'] };
    else if (assertsAuthority(evidence) || assertsAuthority(ctx)) result = { verdict: 'UNRESOLVED', codes: ['CALLER_AUTHORITY_ASSERTED'] };
    else if (!evidence.provenance || !evidence.binding || !evidence.provider || !evidence.invoice || !evidence.lines || !Array.isArray(evidence.lines.items) || !evidence.settlement || !evidence.events)
      result = { verdict: 'UNRESOLVED', codes: ['EVIDENCE_MISSING'] };
    else if (evidence.provenance.evidenceKind !== MOCK_EVIDENCE_KIND) result = { verdict: 'UNRESOLVED', codes: ['EVIDENCE_KIND_UNSUPPORTED'] };
    else if (!isStr(evidence.provenance.snapshotRef) || !DIGEST.test(String(evidence.provenance.snapshotDigest))) result = { verdict: 'UNRESOLVED', codes: ['INPUT_INVALID'] };
    else result = evaluate(ctx, evidence, advisories);
  } catch {
    result = { verdict: 'UNRESOLVED', codes: ['INPUT_INVALID'] }; // malformed input never throws and never classifies as eligible; no error text is returned
  }
  const codes = [...new Set(result.codes)];
  const ok = result.verdict === 'ELIGIBLE';
  const ev = evidence ?? null;
  return {
    classifierVersion: SETTLEMENT_CLASSIFIER_VERSION,
    verdict: result.verdict,
    reasonCodes: codes,
    advisories,
    unresolvedRequirements: ok ? [] : [...new Set(codes.map(c => REQUIREMENT[c]).filter((r): r is string => !!r))],
    evidenceRefs: {
      snapshotRef: safeRef(ev?.provenance?.snapshotRef), snapshotDigest: DIGEST.test(String(ev?.provenance?.snapshotDigest)) ? ev!.provenance.snapshotDigest : null,
      invoiceRef: safeRef(ev?.invoice?.id), benefitItemRef: safeRef(ev?.benefitItem?.itemRef), paymentRef: safeRef(ev?.settlement?.paymentRef),
      allocationDigest: DIGEST.test(String(ctx?.expected?.frozenAllocation?.allocationDigest)) ? ctx.expected.frozenAllocation.allocationDigest : null,
    },
    policyVersion: safeRef(ctx?.policy?.version),
    evaluatedAt: nowOk ? new Date(ctx.nowMs).toISOString() : new Date(0).toISOString(),
    manualReviewRequired: !ok && codes.some(c => MANUAL_REVIEW.has(c)),
    reservationHeld: true,
    grantsFinancialAuthority: false,
  };
}
