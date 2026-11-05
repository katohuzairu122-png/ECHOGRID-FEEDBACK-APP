import { collectPages, type PageRecord } from './pagination';
import { confirmedAbsent, contradictory, unresolved, verified, type EvidenceOrigin, type Field } from './evidence-types';
import type { ProviderProfile } from './provider-profiles';
import type { DisputeOutcome, MockPaymentDispute, MockRefund, RefundFinality } from '../refund-dispute.classifier';

/**
 * S08-D1D3-DEV-07: normalization of refund and payment-dispute history for ONE payment (`REFUNDS_LIST`, `DISPUTES_LIST`: NOT AUTHORIZED, test adapters and synthetic fixtures only).
 *
 * Shapes (per the SDK profile; unproven live):
 *   refund  { id, object, amount, currency, charge, payment_intent, status('pending'|'requires_action'|'succeeded'|'failed'|'canceled' per the SDK doc comment), created }
 *   dispute { id, object, amount, currency, charge, payment_intent, status('needs_response'|'under_review'|'won'|'lost'|'warning_*'|'prevented'), created, livemode }
 *
 * A refund or dispute belongs to THIS payment only if its payment_intent (or, for a charge-settled invoice, its charge) is the payment's. One naming another payment is a contradiction; one
 * that names neither is unattributable (UNRESOLVED), never assumed to be ours. A history is CONFIRMED_ABSENT only when the complete page sequence was read and held no item: an incomplete
 * read, a malformed page or an unsupported API version is UNRESOLVED, never "none".
 *
 * Status mapping to the D3 classifier's vocabulary is literal: won->won, lost->lost, needs_response and under_review->open; the warning_* inquiry states and `prevented` are preserved as
 * `unknown` (a manual-review outcome), and an unlisted value is schema drift. The provider states nothing about whether a refund and a dispute are the same loss, so overlap is always
 * unknown (null) and is never summed. No refund-triggered recovery exists here.
 */
export interface PaymentTarget { readonly kind: 'payment_intent' | 'charge'; readonly ref: string }
export interface HistoryContext {
  readonly businessId: string;
  readonly invoiceId: string;
  /** The settling payment's reference (the classifiers' `paymentRef`). */
  readonly paymentRef: string;
  readonly target: PaymentTarget;
  readonly currency: string;
  readonly paidMinor: number;
  readonly profile: ProviderProfile | null;
}
export interface RefundNormalization { readonly refunds: Field<Readonly<{ items: readonly MockRefund[] }>>; readonly drift: readonly string[] }
export interface DisputeNormalization { readonly disputes: Field<Readonly<{ items: readonly MockPaymentDispute[] }>>; readonly drift: readonly string[] }

const REF = /^[A-Za-z0-9_-]{1,255}$/;
const CURRENCY = /^[a-z]{3}$/;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : isObj(v) && typeof v.id === 'string' ? v.id : null);
const REFUND_STATUS: Readonly<Record<string, RefundFinality>> = Object.freeze({ pending: 'pending', requires_action: 'requires_action', succeeded: 'succeeded', failed: 'failed', canceled: 'canceled' });
const DISPUTE_STATUS: Readonly<Record<string, DisputeOutcome>> = Object.freeze({
  won: 'won', lost: 'lost', needs_response: 'open', under_review: 'open', warning_needs_response: 'unknown', warning_under_review: 'unknown', warning_closed: 'unknown', prevented: 'unknown',
});
const has = (o: Readonly<Record<string, unknown>>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** 'MINE' | 'OTHER' | 'UNATTRIBUTABLE' — does this refund/dispute name the settling payment? */
function association(raw: Record<string, unknown>, target: PaymentTarget): 'MINE' | 'OTHER' | 'UNATTRIBUTABLE' {
  const named = target.kind === 'payment_intent' ? idOf(raw.payment_intent) : idOf(raw.charge);
  if (named === null) return 'UNATTRIBUTABLE'; // the field we can compare is absent: a charge cannot be mapped to a payment intent without a read we do not have
  return named === target.ref ? 'MINE' : 'OTHER';
}

export function normalizeRefundPages(pages: readonly PageRecord[] | null | undefined, ctx: HistoryContext, origin: EvidenceOrigin): RefundNormalization {
  const U = (reason: string, drift: string[] = []): RefundNormalization => ({ refunds: unresolved(reason), drift });
  if (!ctx.profile || !ctx.profile.categories.includes('refunds')) return U('API_VERSION_UNSUPPORTED', ['API_VERSION_UNSUPPORTED:refunds']);
  const collected = collectPages(pages, item => (isObj(item) && typeof item.id === 'string' && REF.test(item.id) ? item.id : null));
  if (collected.state !== 'COMPLETE') return collected.state === 'CONTRADICTORY' ? { refunds: contradictory(collected.reason), drift: [] } : U(collected.reason, collected.state === 'MALFORMED' ? [`REFUNDS_${collected.reason}`] : []);
  if (collected.items.length === 0) return { refunds: confirmedAbsent(origin, 'PROVIDER_SCHEMA'), drift: [] };
  const items: MockRefund[] = []; const drift: string[] = []; const contradictions: string[] = []; let unattributable = false;
  for (const raw of collected.items as Array<Record<string, unknown>>) {
    if (raw.object !== 'refund') { drift.push('REFUND_OBJECT'); continue; }
    if (!isInt(raw.amount) || raw.amount <= 0) { drift.push('REFUND_AMOUNT'); continue; }
    if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency)) { drift.push('REFUND_CURRENCY'); continue; }
    if (typeof raw.status !== 'string' || !has(REFUND_STATUS, raw.status)) { drift.push('REFUND_STATUS'); continue; }
    if (!isInt(raw.created) || raw.created < 0) { drift.push('REFUND_CREATED'); continue; }
    const a = association(raw, ctx.target);
    if (a === 'OTHER') { contradictions.push('REFUND_FOR_OTHER_PAYMENT'); continue; }
    if (a === 'UNATTRIBUTABLE') { unattributable = true; continue; }
    if (raw.currency !== ctx.currency) { contradictions.push('REFUND_CURRENCY_MISMATCH'); continue; }
    items.push({ id: raw.id as string, businessId: ctx.businessId, invoiceRef: ctx.invoiceId, paymentRef: ctx.paymentRef, currency: raw.currency, amountMinor: raw.amount, finality: REFUND_STATUS[raw.status]!, finalizedAtMs: null });
  }
  if (contradictions.length) return { refunds: contradictory([...new Set(contradictions)].join(',')), drift: [] };
  if (drift.length) return U(`SCHEMA_DRIFT:${[...new Set(drift)].join(',')}`, [...new Set(drift)]);
  if (unattributable) return U('REFUND_PAYMENT_ASSOCIATION_UNPROVEN');
  const moving = items.filter(r => r.finality === 'succeeded' || r.finality === 'pending' || r.finality === 'requires_action').reduce((n, r) => n + r.amountMinor, 0);
  if (moving > ctx.paidMinor) return { refunds: contradictory('REFUND_TOTAL_EXCEEDS_PAYMENT'), drift: [] };
  return { refunds: verified({ items }, origin, 'PROVIDER_SCHEMA'), drift: [] };
}

export function normalizeDisputePages(pages: readonly PageRecord[] | null | undefined, ctx: HistoryContext, origin: EvidenceOrigin): DisputeNormalization {
  const U = (reason: string, drift: string[] = []): DisputeNormalization => ({ disputes: unresolved(reason), drift });
  if (!ctx.profile || !ctx.profile.categories.includes('disputes')) return U('API_VERSION_UNSUPPORTED', ['API_VERSION_UNSUPPORTED:disputes']);
  const collected = collectPages(pages, item => (isObj(item) && typeof item.id === 'string' && REF.test(item.id) ? item.id : null));
  if (collected.state !== 'COMPLETE') return collected.state === 'CONTRADICTORY' ? { disputes: contradictory(collected.reason), drift: [] } : U(collected.reason, collected.state === 'MALFORMED' ? [`DISPUTES_${collected.reason}`] : []);
  if (collected.items.length === 0) return { disputes: confirmedAbsent(origin, 'PROVIDER_SCHEMA'), drift: [] };
  const items: MockPaymentDispute[] = []; const drift: string[] = []; const contradictions: string[] = []; let unattributable = false;
  for (const raw of collected.items as Array<Record<string, unknown>>) {
    if (raw.object !== 'dispute') { drift.push('DISPUTE_OBJECT'); continue; }
    if (!isInt(raw.amount) || raw.amount <= 0) { drift.push('DISPUTE_AMOUNT'); continue; }
    if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency)) { drift.push('DISPUTE_CURRENCY'); continue; }
    if (typeof raw.status !== 'string' || !has(DISPUTE_STATUS, raw.status)) { drift.push('DISPUTE_STATUS'); continue; }
    if (raw.livemode !== false) { contradictions.push('DISPUTE_LIVEMODE_NOT_TEST'); continue; }
    const a = association(raw, ctx.target);
    if (a === 'OTHER') { contradictions.push('DISPUTE_FOR_OTHER_PAYMENT'); continue; }
    if (a === 'UNATTRIBUTABLE') { unattributable = true; continue; }
    if (raw.currency !== ctx.currency) { contradictions.push('DISPUTE_CURRENCY_MISMATCH'); continue; }
    items.push({ id: raw.id as string, businessId: ctx.businessId, invoiceRef: ctx.invoiceId, paymentRef: ctx.paymentRef, currency: raw.currency, amountMinor: raw.amount, outcome: DISPUTE_STATUS[raw.status]!, closedAtMs: null, overlapsRefundIds: null });
  }
  if (contradictions.length) return { disputes: contradictory([...new Set(contradictions)].join(',')), drift: [] };
  if (drift.length) return U(`SCHEMA_DRIFT:${[...new Set(drift)].join(',')}`, [...new Set(drift)]);
  if (unattributable) return U('DISPUTE_PAYMENT_ASSOCIATION_UNPROVEN');
  const lost = items.filter(d => d.outcome === 'lost').reduce((n, d) => n + d.amountMinor, 0);
  if (lost > ctx.paidMinor || items.some(d => d.amountMinor > ctx.paidMinor)) return { disputes: contradictory('DISPUTE_TOTAL_EXCEEDS_PAYMENT'), drift: [] };
  return { disputes: verified({ items }, origin, 'PROVIDER_SCHEMA'), drift: [] };
}

/**
 * Checks across the two histories. The facts stay VERIFIED and preserved; these codes make the bundle incomplete and force manual review in the bridge. The provider never states whether a
 * refund and a dispute are one loss, so any refund (not failed/canceled) alongside any dispute is an UNDETERMINED overlap, and several disputes on one payment are undefined by policy.
 */
export function crossCheckHistories(refunds: Field<Readonly<{ items: readonly MockRefund[] }>>, disputes: Field<Readonly<{ items: readonly MockPaymentDispute[] }>>): string[] {
  const codes: string[] = [];
  const r = refunds.state === 'VERIFIED' ? refunds.value!.items : []; const d = disputes.state === 'VERIFIED' ? disputes.value!.items : [];
  if (r.some(x => x.finality !== 'failed' && x.finality !== 'canceled') && d.length > 0) codes.push('REFUND_DISPUTE_OVERLAP_UNDETERMINED');
  if (d.length > 1) codes.push('MULTIPLE_DISPUTES_ON_PAYMENT');
  return codes;
}
