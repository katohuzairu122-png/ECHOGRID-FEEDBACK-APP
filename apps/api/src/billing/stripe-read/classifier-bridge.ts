import { sealedOriginOf } from './evidence-origin';
import { established, EVIDENCE_CONTRACT_VERSION, type NormalizedStripeEvidence } from './evidence-types';
import {
  classifySettlement, MOCK_EVIDENCE_KIND, type DisputeEvidence, type MockInvoiceLine, type MockSettlementEvidence, type RefundEvidence, type SettlementClassification, type SettlementClassifierContext,
} from '../settlement-eligibility.classifier';
import {
  classifyRefundDispute, EVIDENCE_ORIGIN, type MockRefundDisputeEvidence, type RefundDisputeClassification, type RefundDisputeContext,
} from '../refund-dispute.classifier';

/**
 * S08-D1D3-DEV-06: the strict bridge from normalized provider evidence to the existing D1 and D3 classifiers. It adds NO policy of its own and changes none of theirs.
 *
 *  - It trusts a bundle only by its seal (object identity), never by what the object says about itself.
 *  - Only `MOCK_FIXTURE` evidence is converted into the classifiers' (mock) evidence kind. A bundle from a real test-mode read is NOT converted: it reaches the classifiers labelled with
 *    an evidence kind they do not accept, so they answer UNRESOLVED / EVIDENCE_KIND_UNSUPPORTED themselves. Real evidence cannot authorize anything until a real evidence envelope is
 *    separately specified (the classifier header says so); that is why no authorization row can be recorded from it.
 *  - Uncertainty is carried through as "unknown" (refund, dispute, cancellation, settlement source), never as "none".
 */
export type BridgeOrigin = 'MOCK_FIXTURE' | 'STRIPE_TEST_READ' | 'UNSEALED';
export interface ClassifierBinding { readonly businessId: string; readonly reservationId: string; readonly intentRef: string }
export interface BundleClassification {
  readonly origin: BridgeOrigin;
  readonly settlement: SettlementClassification;
  readonly refundDispute: RefundDisputeClassification | null;
  /** Present only for MOCK_FIXTURE evidence that could be converted; this is the ONLY object a recorder is ever given. */
  readonly settlementEvidence: MockSettlementEvidence | null;
}

const money = (n: number | null): number => (n === null ? 0 : n);

export function refundExtent(b: NormalizedStripeEvidence, paidMinor: number): RefundEvidence {
  if (b.refunds.state === 'CONFIRMED_ABSENT') return 'none';
  if (b.refunds.state !== 'VERIFIED') return 'unknown';
  const items = b.refunds.value!.items;
  if (items.length === 0) return 'unknown'; // a verified EMPTY list is not a confirmed absence; absence must be stated as such
  if (items.some(r => r.finality === 'pending' || r.finality === 'requires_action')) return 'pending';
  if (items.some(r => r.finality === 'unknown')) return 'unknown';
  const done = items.filter(r => r.finality === 'succeeded').reduce((n, r) => n + r.amountMinor, 0);
  if (done <= 0) return 'unknown'; // only failed/canceled refunds: no money moved, but that is a statement we do not derive here
  return done >= paidMinor ? 'full' : 'partial';
}

export function disputeState(b: NormalizedStripeEvidence): DisputeEvidence {
  if (b.disputes.state === 'CONFIRMED_ABSENT') return 'none';
  if (b.disputes.state !== 'VERIFIED') return 'unknown';
  const items = b.disputes.value!.items;
  if (items.length !== 1) return 'unknown'; // none-listed is not absence; several disputes are undefined by the existing policy and stay fail-closed
  const d = items[0]!;
  return d.outcome === 'open' ? 'open' : d.outcome === 'lost' ? 'lost' : d.outcome === 'won' ? 'won' : 'unknown';
}

function refundDisputeEvidence(b: NormalizedStripeEvidence): MockRefundDisputeEvidence | null {
  const inv = b.invoice;
  if (!established(b.settlingPayment) || b.settlingPayment.state !== 'VERIFIED' || b.settlingPayment.value!.source !== 'stripe_payment' || inv.amounts.state !== 'VERIFIED' || inv.currency.state !== 'VERIFIED') return null;
  const refunds = b.refunds.state === 'VERIFIED' ? b.refunds.value!.items : [];
  const disputes = b.disputes.state === 'VERIFIED' ? b.disputes.value!.items : [];
  const fp = { paidMinor: inv.amounts.value!.paidMinor, refundCount: refunds.length, disputeCount: disputes.length, contentDigest: b.digest };
  return {
    provenance: { evidenceKind: MOCK_EVIDENCE_KIND, origin: EVIDENCE_ORIGIN, snapshotRef: `mock:${b.digest.slice(0, 32)}`, snapshotDigest: b.digest, observedAtMs: b.observedAtMs, providerOutcome: 'ok',
      complete: b.stable.state === 'VERIFIED' && established(b.refunds) && established(b.disputes), readBefore: fp, readAfter: fp }, // completeness of THIS history only: the D3 classifier must see (and itself judge) contradictions in it, not be pre-empted by unrelated invoice findings
    binding: { businessId: b.requested.businessId },
    provider: { accountId: b.accountId.value as string, mode: 'test' },
    payment: { ref: b.settlingPayment.value!.ref, invoiceRef: b.requested.invoiceId, currency: inv.currency.value as string, paidMinor: inv.amounts.value!.paidMinor },
    refunds: { complete: established(b.refunds), items: refunds },
    disputes: { complete: established(b.disputes), items: disputes },
  };
}

function settlementEvidence(b: NormalizedStripeEvidence, binding: ClassifierBinding, events: { refund: RefundEvidence; dispute: DisputeEvidence }): MockSettlementEvidence | null {
  const i = b.invoice;
  if (i.status.state !== 'VERIFIED' || i.currency.state !== 'VERIFIED' || i.amounts.state !== 'VERIFIED' || i.createdAtMs.state !== 'VERIFIED' || i.customerRef.state !== 'VERIFIED' ||
      i.subscriptionRef.state !== 'VERIFIED' || !established(i.paidAtMs) || !established(i.voidedAtMs) || i.lines.state !== 'VERIFIED' || b.accountId.state !== 'VERIFIED') return null; // core invoice facts not established: nothing to classify
  const a = i.amounts.value!;
  const attribution = b.lineAttribution.state === 'VERIFIED' ? new Map(b.lineAttribution.value!.map(x => [x.lineRef, x] as const)) : null;
  const attributed = attribution !== null && i.lines.value!.items.every(l => attribution.has(l.lineRef));
  const items: MockInvoiceLine[] = i.lines.value!.items.map(l => {
    const at = attribution?.get(l.lineRef);
    return { lineRef: l.lineRef, amountMinor: l.amountMinor, currency: l.currency, category: at?.category ?? 'other', parentItemRef: at?.parentItemRef ?? null, parentItemKey: at?.parentItemKey ?? null, labelReservationRef: at?.labelReservationRef ?? null };
  });
  const fp = { status: i.status.value as string, amountDueMinor: a.dueMinor, amountPaidMinor: a.paidMinor, amountRemainingMinor: a.remainingMinor, totalMinor: a.totalMinor, lineCount: items.length };
  const payment = b.settlingPayment.state === 'VERIFIED' ? b.settlingPayment.value! : null;
  return {
    provenance: { evidenceKind: MOCK_EVIDENCE_KIND, snapshotRef: `mock:${b.digest.slice(0, 32)}`, snapshotDigest: b.digest, observedAtMs: b.observedAtMs, providerOutcome: 'ok',
      complete: b.complete, readBefore: fp, readAfter: fp },
    binding: { businessId: binding.businessId, reservationId: binding.reservationId, intentRef: binding.intentRef },
    provider: { accountId: b.accountId.value as string, mode: 'test' },
    invoice: { id: b.requested.invoiceId, customerRef: i.customerRef.value as string, subscriptionRef: i.subscriptionRef.value as string, currency: i.currency.value as string, status: i.status.value as string,
      amountDueMinor: a.dueMinor, amountPaidMinor: a.paidMinor, amountRemainingMinor: a.remainingMinor, totalMinor: a.totalMinor, createdAtMs: i.createdAtMs.value as number,
      paidAtMs: i.paidAtMs.state === 'VERIFIED' ? (i.paidAtMs.value as number) : null, voidedAtMs: i.voidedAtMs.state === 'VERIFIED' ? (i.voidedAtMs.value as number) : null,
      billingInterval: b.billingInterval.state === 'VERIFIED' ? (b.billingInterval.value as 'month' | 'year') : 'unknown' },
    lines: { complete: i.lines.value!.pageComplete && attributed, items },
    benefitItem: b.benefitItem.state === 'VERIFIED' ? b.benefitItem.value! : null,
    settlement: { source: payment ? payment.source : 'unknown', paymentRef: payment ? payment.ref : null },
    events: { refund: events.refund, dispute: events.dispute, cancellation: b.cancellation.state === 'VERIFIED' ? b.cancellation.value! : b.cancellation.state === 'CONFIRMED_ABSENT' ? 'none' : 'unknown' },
  };
}

/** Runs the D1 settlement classifier (and, when a context is supplied, the D3 refund/dispute classifier) over a normalized bundle. Never throws; every uncertainty is UNRESOLVED. */
export function classifyBundle(
  ctx: SettlementClassifierContext, bundle: NormalizedStripeEvidence, binding: ClassifierBinding, refundDisputeCtx: RefundDisputeContext | null = null,
): BundleClassification {
  const sealedOrigin = sealedOriginOf(bundle);
  const origin: BridgeOrigin = sealedOrigin ?? 'UNSEALED';
  // A bundle claiming one origin while sealed with another is as untrusted as an unsealed one.
  if (sealedOrigin === null || bundle.origin !== sealedOrigin || sealedOrigin === 'STRIPE_TEST_READ' || bundle.contractVersion !== EVIDENCE_CONTRACT_VERSION) {
    const labelled = { provenance: { evidenceKind: sealedOrigin === 'STRIPE_TEST_READ' ? 'STRIPE_TEST_READ' : 'UNSEALED' } } as unknown as MockSettlementEvidence;
    // the classifier's own rule rejects any evidence kind other than the mock kind; nothing is relaxed for real evidence
    const full = { ...labelled, binding, provider: { accountId: 'x', mode: 'test' }, invoice: {}, lines: { items: [] }, settlement: {}, events: {} } as unknown as MockSettlementEvidence;
    return { origin, settlement: classifySettlement(ctx, full), refundDispute: null, settlementEvidence: null };
  }
  let refund = refundExtent(bundle, bundle.invoice.amounts.state === 'VERIFIED' ? bundle.invoice.amounts.value!.paidMinor : money(null));
  let dispute = disputeState(bundle);
  // Any contradiction in the bundle (an undetermined refund/dispute overlap, several disputes, a payment-loss total that cannot be right, a timeline conflict) is preserved and forces manual review:
  // the refund and dispute states become "unknown" so no positive classification can rest on evidence that disagrees with itself.
  if (bundle.contradictions.length > 0 || bundle.schemaDrift.length > 0) { refund = 'unknown'; dispute = 'unknown'; }
  let rd: RefundDisputeClassification | null = null;
  const rdEvidence = refundDisputeCtx ? refundDisputeEvidence(bundle) : null;
  if (refundDisputeCtx) {
    rd = classifyRefundDispute(refundDisputeCtx, rdEvidence);
    // the D3 classification has the last word on contradictions and unreachable evidence: both sides become "unknown"
    if (rd.classification === 'CONTRADICTORY_EVIDENCE' || rd.classification === 'PROVIDER_UNREACHABLE') { refund = 'unknown'; dispute = 'unknown'; }
  }
  const evidence = settlementEvidence(bundle, binding, { refund, dispute });
  return { origin, settlement: classifySettlement(ctx, evidence), refundDispute: rd, settlementEvidence: evidence };
}
