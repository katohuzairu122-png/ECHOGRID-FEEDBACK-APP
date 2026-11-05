import { collectPages, type PageRecord } from './pagination';
import { contradictory, unresolved, verified, type EvidenceOrigin, type Field, type SettlingPayment } from './evidence-types';
import type { ProviderProfile } from './provider-profiles';

/**
 * S08-D1D3-DEV-07: normalization of the invoice's settling-payment evidence (`PAYMENT_RETRIEVE`, NOT AUTHORIZED: test adapters and synthetic fixtures only).
 *
 * Shape (per the SDK profile; unproven live): invoice_payment { id, object, amount_paid, amount_requested, currency, invoice, livemode, payment{ type, payment_intent | charge | payment_record },
 * status('open'|'paid'|'canceled'), status_transitions{ paid_at, canceled_at }, created }.
 *
 * An invoice that CLAIMS to be paid is not settled evidence. Settlement is established only by exactly one `paid` invoice payment that belongs to this invoice, has the invoice's currency,
 * carries exactly the amount the invoice says was paid, has a coherent paid time and names an unambiguous payment (a payment intent or a charge). Zero paid payments, several, a payment of
 * another invoice, duplicate references or any drift leaves the settling payment UNRESOLVED or CONTRADICTORY. Nothing here starts, confirms or moves money.
 */
export interface PaymentContext {
  readonly invoiceId: string;
  readonly currency: string;
  readonly invoiceStatus: string;
  readonly invoicePaidMinor: number;
  readonly invoiceCreatedAtMs: number;
  readonly observedAtMs: number;
  readonly profile: ProviderProfile | null;
}
export interface PaymentNormalization { readonly payment: Field<SettlingPayment>; readonly drift: readonly string[] }

const REF = /^[A-Za-z0-9_-]{1,255}$/;
const CURRENCY = /^[a-z]{3}$/;
const STATUSES = ['open', 'paid', 'canceled'];
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : isObj(v) && typeof v.id === 'string' ? v.id : null);

export function normalizeInvoicePayments(pages: readonly PageRecord[] | null | undefined, ctx: PaymentContext, origin: EvidenceOrigin): PaymentNormalization {
  const U = (reason: string, drift: string[] = []): PaymentNormalization => ({ payment: unresolved(reason), drift });
  const C = (reason: string): PaymentNormalization => ({ payment: contradictory(reason), drift: [] });
  if (!ctx.profile || !ctx.profile.categories.includes('invoice_payments')) return U('API_VERSION_UNSUPPORTED', ['API_VERSION_UNSUPPORTED:invoice_payments']);
  if (ctx.invoiceStatus !== 'paid') return U('INVOICE_NOT_SETTLED'); // nothing to confirm yet; an unpaid or partly paid invoice is the classifier's finding, not a payment fact
  const collected = collectPages(pages, item => (isObj(item) && typeof item.id === 'string' && REF.test(item.id) ? item.id : null));
  if (collected.state !== 'COMPLETE') return collected.state === 'CONTRADICTORY' ? C(collected.reason) : U(collected.reason, collected.state === 'MALFORMED' ? [`PAYMENTS_${collected.reason}`] : []);

  const paid: Array<{ rec: Record<string, unknown>; target: { kind: 'payment_intent' | 'charge'; ref: string } }> = [];
  const drift: string[] = []; const contradictions: string[] = []; let unsupportedType = false;
  for (const raw of collected.items as Array<Record<string, unknown>>) {
    if (raw.object !== 'invoice_payment') { drift.push('PAYMENT_OBJECT'); continue; }
    if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) { drift.push('PAYMENT_STATUS'); continue; }
    const inv = idOf(raw.invoice);
    if (inv === null) { drift.push('PAYMENT_INVOICE_MISSING'); continue; }
    if (inv !== ctx.invoiceId) { contradictions.push('PAYMENT_FOR_OTHER_INVOICE'); continue; }
    if (raw.livemode !== false) { contradictions.push('PAYMENT_LIVEMODE_NOT_TEST'); continue; }
    if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency)) { drift.push('PAYMENT_CURRENCY'); continue; }
    if (raw.currency !== ctx.currency) { contradictions.push('PAYMENT_CURRENCY_MISMATCH'); continue; }
    if (raw.status !== 'paid') continue; // open and canceled payments are valid records that settle nothing
    const pay = isObj(raw.payment) ? raw.payment : null;
    if (!pay || typeof pay.type !== 'string') { drift.push('PAYMENT_TARGET_SHAPE'); continue; }
    if (pay.type !== 'payment_intent' && pay.type !== 'charge') { unsupportedType = true; continue; }
    const ref = idOf(pay[pay.type]);
    if (ref === null || !REF.test(ref)) { drift.push('PAYMENT_TARGET_MISSING'); continue; }
    paid.push({ rec: raw, target: { kind: pay.type, ref } });
  }
  if (contradictions.length) return C([...new Set(contradictions)].join(','));
  if (drift.length) return U(`SCHEMA_DRIFT:${[...new Set(drift)].join(',')}`, [...new Set(drift)]);
  if (unsupportedType) return U('PAYMENT_TYPE_UNSUPPORTED');
  if (paid.length === 0) return U('SETTLEMENT_CONFIRMATION_MISSING'); // "paid" on the invoice, but no paid payment on record: out-of-band or incomplete evidence, never a settlement
  const refs = paid.map(p => p.target.ref);
  if (new Set(refs).size !== refs.length) return C('DUPLICATE_PAYMENT_REFERENCE'); // two records naming one payment must not count twice
  if (paid.length > 1) return U('MULTIPLE_SETTLING_PAYMENTS'); // split settlement is a policy question, not guessed here
  const { rec, target } = paid[0]!;
  const amount = rec.amount_paid;
  if (!isInt(amount) || amount <= 0) return U('PAYMENT_AMOUNT_MISSING_OR_INVALID');
  if (amount !== ctx.invoicePaidMinor) return C('PAYMENT_AMOUNT_MISMATCH');
  const st = isObj(rec.status_transitions) ? rec.status_transitions : null;
  if (!st || !('paid_at' in st)) return U('PAYMENT_PAID_AT_MISSING');
  if (st.paid_at === null) return C('PAID_WITHOUT_PAID_AT');
  if (!isInt(st.paid_at) || st.paid_at < 0 || !Number.isSafeInteger(st.paid_at * 1000)) return U('PAYMENT_PAID_AT_MALFORMED', ['PAYMENT_PAID_AT']);
  const paidAtMs = st.paid_at * 1000;
  if (paidAtMs < ctx.invoiceCreatedAtMs) return C('PAYMENT_BEFORE_INVOICE_CREATION');
  if (paidAtMs > ctx.observedAtMs) return C('PAYMENT_PAID_AT_IN_FUTURE');
  return { payment: verified<SettlingPayment>({ ref: target.ref, source: 'stripe_payment', details: { paymentRecordRef: rec.id as string, kind: target.kind, amountMinor: amount, currency: ctx.currency, paidAtMs } }, origin, 'PROVIDER_SCHEMA'), drift: [] };
}
