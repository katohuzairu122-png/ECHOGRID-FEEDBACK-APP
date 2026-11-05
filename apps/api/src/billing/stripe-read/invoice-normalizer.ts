import {
  confirmedAbsent, contradictory, established, unresolved, verified,
  type EvidenceOrigin, type Field, type InvoiceFacts, type InvoiceStatusValue, type MappingStatus, type NormalizedLine,
} from './evidence-types';

/**
 * S08-D1D3-DEV-06: strict normalization of ONE Stripe invoice response into typed facts.
 *
 * Field names are those of the Invoice object in the pinned Stripe SDK type definitions (shape only; not proven against a live response, which needs Q1/Q2): id, object, livemode,
 * currency, status, customer, parent.subscription_details.subscription, amount_due, amount_paid, amount_remaining, total, created, status_transitions.{paid_at,voided_at} and the
 * embedded lines {data[].id, data[].amount, data[].currency, has_more}. Nothing else is read. A field that is missing, of the wrong type, malformed or inconsistent with another
 * field becomes UNRESOLVED or CONTRADICTORY: it is never defaulted, coerced or repaired, and an uncertain value never becomes a positive one.
 *
 * Identity checks (object, invoice id, test realm, tenant/customer/subscription binding) are DENIALS, not unresolved fields: evidence about a different invoice, account realm or
 * tenant is not evidence of this one and is not returned at all.
 */
export type NormalizeDenial = 'OBJECT_MISMATCH' | 'INVOICE_IDENTITY_MISMATCH' | 'REALM_MISMATCH' | 'BINDING_MISMATCH';
export interface TrustedInvoiceScope { readonly businessId: string; readonly invoiceId: string; readonly customerId: string; readonly subscriptionId: string }
export interface InvoiceFingerprint { readonly status: string | null; readonly dueMinor: number | null; readonly paidMinor: number | null; readonly remainingMinor: number | null; readonly totalMinor: number | null; readonly lineCount: number | null }
export type NormalizedInvoice =
  | Readonly<{ denied: NormalizeDenial }>
  | Readonly<{ denied: null; facts: InvoiceFacts; contradictions: readonly string[]; fingerprint: InvoiceFingerprint }>;

const STATUSES: readonly InvoiceStatusValue[] = ['draft', 'open', 'paid', 'void', 'uncollectible'];
const CURRENCY = /^[a-z]{3}$/;
const LINE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const refOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : isObj(v) && typeof v.id === 'string' && v.id.length > 0 ? v.id : null);

export function normalizeInvoice(raw: unknown, trusted: TrustedInvoiceScope, observedAtMs: number, origin: EvidenceOrigin, mapping: MappingStatus = 'PROVIDER_SCHEMA'): NormalizedInvoice {
  if (!isObj(raw) || raw.object !== 'invoice') return { denied: 'OBJECT_MISMATCH' };
  if (raw.id !== trusted.invoiceId) return { denied: 'INVOICE_IDENTITY_MISMATCH' };
  if (raw.livemode !== false) return { denied: 'REALM_MISMATCH' }; // true, missing, null or any non-boolean: never a test invoice
  const customer = refOf(raw.customer);
  const parent = isObj(raw.parent) ? raw.parent : null;
  const sub = parent && parent.type === 'subscription_details' && isObj(parent.subscription_details) ? refOf(parent.subscription_details.subscription) : null;
  // A present reference that differs from the trusted one is a binding failure. An absent one is merely unresolved (below).
  if ((customer !== null && customer !== trusted.customerId) || (sub !== null && sub !== trusted.subscriptionId)) return { denied: 'BINDING_MISMATCH' };

  const contradictions: string[] = [];
  const ok = <T>(v: T) => verified(v, origin, mapping);
  const bad = <T>(reason: string): Field<T> => { contradictions.push(reason); return contradictory<T>(reason); };

  const status: Field<InvoiceStatusValue> = typeof raw.status === 'string' && (STATUSES as readonly string[]).includes(raw.status) ? ok(raw.status as InvoiceStatusValue) : unresolved('STATUS_MISSING_OR_UNKNOWN');
  const currency: Field<string> = typeof raw.currency === 'string' && CURRENCY.test(raw.currency) ? ok(raw.currency) : unresolved('CURRENCY_MISSING_OR_MALFORMED');
  const customerRef: Field<string> = customer ? ok(customer) : unresolved('CUSTOMER_MISSING');
  const subscriptionRef: Field<string> = sub ? ok(sub) : unresolved('SUBSCRIPTION_PARENT_MISSING');

  // Unix SECONDS -> epoch milliseconds. Non-integers, negatives and values later than the server's own observation are refused, not clamped.
  const ts = (v: unknown, key: string, nullable: boolean): Field<number> => {
    if (!(key in (raw.status_transitions as object ?? {})) && key !== 'created') return unresolved(`${key.toUpperCase()}_MISSING`);
    if (v === null) return nullable ? confirmedAbsent<number>(origin, mapping) : unresolved(`${key.toUpperCase()}_NULL`);
    if (!isInt(v) || v < 0) return unresolved(`${key.toUpperCase()}_MALFORMED`);
    const ms = v * 1000;
    if (!Number.isSafeInteger(ms)) return unresolved(`${key.toUpperCase()}_MALFORMED`);
    if (ms > observedAtMs) return bad(`${key.toUpperCase()}_IN_FUTURE`);
    return ok(ms);
  };
  const st = isObj(raw.status_transitions) ? raw.status_transitions : null;
  const createdAtMs: Field<number> = isInt(raw.created) || raw.created === null ? ts(raw.created, 'created', false) : unresolved('CREATED_MALFORMED');
  const paidAtMs: Field<number> = st ? ts(st.paid_at, 'paid_at', true) : unresolved('STATUS_TRANSITIONS_MISSING');
  const voidedAtMs: Field<number> = st ? ts(st.voided_at, 'voided_at', true) : unresolved('STATUS_TRANSITIONS_MISSING');

  const nn = (n: unknown): n is number => isInt(n) && n >= 0;
  const amountsOk = nn(raw.amount_due) && nn(raw.amount_paid) && nn(raw.amount_remaining) && isInt(raw.total) && raw.total >= 0;
  let amounts: InvoiceFacts['amounts'];
  if (!amountsOk) amounts = unresolved('AMOUNTS_MISSING_OR_MALFORMED');
  else if ((raw.amount_paid as number) + (raw.amount_remaining as number) !== raw.amount_due) amounts = bad('AMOUNTS_INCONSISTENT');
  else amounts = ok({ dueMinor: raw.amount_due as number, paidMinor: raw.amount_paid as number, remainingMinor: raw.amount_remaining as number, totalMinor: raw.total as number });

  // Embedded first page of lines only. has_more=true (or a missing flag) means the list is incomplete: the lines are then unresolved, never "the lines we saw".
  let lines: InvoiceFacts['lines'];
  const embedded = isObj(raw.lines) ? raw.lines : null;
  if (!embedded || !Array.isArray(embedded.data) || typeof embedded.has_more !== 'boolean') lines = unresolved('LINES_MISSING_OR_MALFORMED');
  else if (embedded.has_more) lines = unresolved('LINES_PAGE_INCOMPLETE');
  else {
    const items: NormalizedLine[] = []; let malformed = false;
    for (const l of embedded.data as unknown[]) {
      if (!isObj(l) || typeof l.id !== 'string' || !LINE_ID.test(l.id) || !isInt(l.amount) || typeof l.currency !== 'string' || !CURRENCY.test(l.currency)) { malformed = true; break; }
      items.push({ lineRef: l.id, amountMinor: l.amount, currency: l.currency });
    }
    if (malformed) lines = unresolved('LINE_MALFORMED');
    else if (new Set(items.map(i => i.lineRef)).size !== items.length) lines = bad('DUPLICATE_LINE');
    else if (currency.state === 'VERIFIED' && items.some(i => i.currency !== currency.value)) lines = bad('LINE_CURRENCY_MISMATCH');
    else if (amounts.state === 'VERIFIED' && items.reduce((n, i) => n + i.amountMinor, 0) !== amounts.value!.totalMinor) lines = bad('LINES_TOTAL_MISMATCH');
    else lines = ok({ items, pageComplete: true });
  }

  // Cross-field contradictions. They mark the facts they concern as CONTRADICTORY; nothing is repaired.
  const note = (reason: string) => { if (!contradictions.includes(reason)) contradictions.push(reason); };
  if (established(status) && status.value === 'paid' && amounts.state === 'VERIFIED' && amounts.value!.remainingMinor !== 0) note('PAID_WITH_REMAINING');
  if (established(status) && status.value !== 'paid' && paidAtMs.state === 'VERIFIED') note('PAID_AT_WITHOUT_PAID_STATUS');
  if (established(status) && status.value === 'paid' && paidAtMs.state === 'CONFIRMED_ABSENT') note('PAID_WITHOUT_PAID_AT');
  if (established(status) && status.value === 'void' && voidedAtMs.state === 'CONFIRMED_ABSENT') note('VOID_WITHOUT_VOIDED_AT');
  if (paidAtMs.state === 'VERIFIED' && voidedAtMs.state === 'VERIFIED') note('PAID_AND_VOIDED');
  if (createdAtMs.state === 'VERIFIED') for (const t of [paidAtMs, voidedAtMs]) if (t.state === 'VERIFIED' && (t.value as number) < (createdAtMs.value as number)) note('TRANSITION_BEFORE_CREATION');
  const mark = <T>(f: Field<T>, reason: string, cond: boolean): Field<T> => (cond ? contradictory<T>(reason) : f);
  const paidBad = contradictions.includes('PAID_AT_WITHOUT_PAID_STATUS') || contradictions.includes('PAID_WITHOUT_PAID_AT') || contradictions.includes('PAID_AND_VOIDED') || contradictions.includes('TRANSITION_BEFORE_CREATION');
  const finalStatus = mark(status, 'PAID_WITH_REMAINING', contradictions.includes('PAID_WITH_REMAINING') || contradictions.includes('PAID_WITHOUT_PAID_AT') || contradictions.includes('VOID_WITHOUT_VOIDED_AT'));

  const facts: InvoiceFacts = {
    id: ok(trusted.invoiceId), status: finalStatus, currency, customerRef, subscriptionRef, createdAtMs,
    paidAtMs: mark(paidAtMs, 'TIMELINE_CONTRADICTION', paidBad), voidedAtMs: mark(voidedAtMs, 'TIMELINE_CONTRADICTION', contradictions.includes('PAID_AND_VOIDED') || contradictions.includes('TRANSITION_BEFORE_CREATION')),
    amounts, lines,
  };
  const fingerprint: InvoiceFingerprint = {
    status: typeof raw.status === 'string' ? raw.status : null, dueMinor: amountsOk ? (raw.amount_due as number) : null, paidMinor: amountsOk ? (raw.amount_paid as number) : null,
    remainingMinor: amountsOk ? (raw.amount_remaining as number) : null, totalMinor: amountsOk ? (raw.total as number) : null,
    lineCount: embedded && Array.isArray(embedded.data) && embedded.has_more === false ? embedded.data.length : null,
  };
  return { denied: null, facts, contradictions: Object.freeze([...contradictions]), fingerprint };
}
