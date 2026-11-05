import { assembleEvidence } from './bundle-builder';
import { sealBundle } from './evidence-origin';
import { confirmedAbsent, unresolved, verified, type Field, type InvoiceFacts, type NormalizedStripeEvidence, type SettlingPayment } from './evidence-types';
import { normalizeInvoice, type NormalizeDenial, type TrustedInvoiceScope } from './invoice-normalizer';
import { normalizeLinePages, type FrozenReference, type IdempotencyEvidence } from './line-normalizer';
import type { PageRecord } from './pagination';
import { normalizeInvoicePayments } from './payment-normalizer';
import { profileFor } from './provider-profiles';
import { crossCheckHistories, normalizeDisputePages, normalizeRefundPages, type PaymentTarget } from './refund-dispute-normalizer';
import type { MockPaymentDispute, MockRefund } from '../refund-dispute.classifier';
import type { CancellationEvidence, MockBenefitItem } from '../settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-07: the TEST-ADAPTER side of the four unauthorized reads (`INVOICE_LINES_LIST`, `PAYMENT_RETRIEVE`, `REFUNDS_LIST`, `DISPUTES_LIST`).
 *
 * An `ExtendedReadSource` is typed and checked at runtime as `MOCK_FIXTURE`. There is deliberately no implementation that talks to Stripe and no way to build one from the real transport:
 * the real transport has exactly two paths (see transport.ts) and the capability registry keeps these four NOT_AUTHORIZED. Evidence acquired here is sealed `MOCK_FIXTURE`, so the classifier
 * bridge will classify it (positive mock paths) and will never treat it as authentic Stripe evidence. The raw pages are in the provider-profile shape, so the normalizers exercised here are the
 * ones a future authorized, proven real read would use.
 */
export interface ExtendedReadSource {
  readonly sourceKind: 'MOCK_FIXTURE';
  listInvoiceLines(invoiceId: string): Promise<readonly PageRecord[]>;
  listInvoicePayments(invoiceId: string): Promise<readonly PageRecord[]>;
  listRefunds(target: PaymentTarget): Promise<readonly PageRecord[]>;
  listDisputes(target: PaymentTarget): Promise<readonly PageRecord[]>;
}

/** Fixture-backed source. Every call is recorded so tests can assert what was (not) asked. */
export class MockExtendedSource implements ExtendedReadSource {
  readonly sourceKind = 'MOCK_FIXTURE' as const;
  readonly calls: string[] = [];
  constructor(private readonly fixtures: Readonly<{ lines?: readonly PageRecord[]; payments?: readonly PageRecord[]; refunds?: readonly PageRecord[]; disputes?: readonly PageRecord[] }>) {}
  async listInvoiceLines(invoiceId: string) { this.calls.push(`lines:${invoiceId}`); return this.fixtures.lines ?? []; }
  async listInvoicePayments(invoiceId: string) { this.calls.push(`payments:${invoiceId}`); return this.fixtures.payments ?? []; }
  async listRefunds(t: PaymentTarget) { this.calls.push(`refunds:${t.kind}:${t.ref}`); return this.fixtures.refunds ?? []; }
  async listDisputes(t: PaymentTarget) { this.calls.push(`disputes:${t.kind}:${t.ref}`); return this.fixtures.disputes ?? []; }
}

/** One complete page (no cursor, has_more=false). */
export const onePage = (data: readonly unknown[]): PageRecord[] => [{ requestedStartingAfter: null, body: { object: 'list', data, has_more: false, url: '/v1/fixture' } }];
/** The same items split into pages of `size`, with the cursors a correct client would have used. */
export function pagesOf(data: ReadonlyArray<{ id: string }>, size: number): PageRecord[] {
  const out: PageRecord[] = [];
  for (let i = 0; i < data.length || i === 0; i += size) {
    const slice = data.slice(i, i + size);
    out.push({ requestedStartingAfter: i === 0 ? null : data[i - 1]!.id, body: { object: 'list', data: slice, has_more: i + size < data.length, url: '/v1/fixture' } });
    if (data.length === 0) break;
  }
  return out;
}

export type Slot<T> = T | 'absent' | 'unresolved';
export interface ExtendedMockInput {
  readonly scope: TrustedInvoiceScope;
  readonly accountId: string;
  readonly observedAtMs: number;
  readonly apiVersion: string;
  readonly invoiceBefore: unknown;
  readonly invoiceAfter?: unknown;
  readonly source: ExtendedReadSource;
  /** Read-only references to the frozen allocation; never modified or recalculated. */
  readonly frozen: readonly FrozenReference[] | null;
  /** Separate provider evidence of the parent item's idempotency key (does not exist for real reads). */
  readonly idempotency: readonly IdempotencyEvidence[] | null;
  readonly billingInterval: 'month' | 'year' | 'unresolved';
  readonly benefitItem: Slot<MockBenefitItem>;
  readonly cancellation: Exclude<CancellationEvidence, 'unknown'> | 'unresolved';
}
export type ExtendedMockResult = { ok: true; evidence: NormalizedStripeEvidence } | { ok: false; denied: NormalizeDenial | 'METHOD_NOT_AUTHORIZED' };

const slot = <T>(v: Slot<T>, reason: string): Field<T> => (v === 'unresolved' ? unresolved<T>(reason) : v === 'absent' ? confirmedAbsent<T>('MOCK_FIXTURE', 'MOCK') : verified(v, 'MOCK_FIXTURE', 'MOCK'));
const allUnresolved = (reason: string): InvoiceFacts => ({
  id: unresolved(reason), status: unresolved(reason), currency: unresolved(reason), customerRef: unresolved(reason), subscriptionRef: unresolved(reason), createdAtMs: unresolved(reason),
  paidAtMs: unresolved(reason), voidedAtMs: unresolved(reason), amounts: unresolved(reason), lines: unresolved(reason),
});

export async function acquireMockExtendedEvidence(input: ExtendedMockInput): Promise<ExtendedMockResult> {
  // a real source can never be plugged in here: anything that is not the mock source is refused before any read
  if (!input?.source || input.source.sourceKind !== 'MOCK_FIXTURE') return { ok: false, denied: 'METHOD_NOT_AUTHORIZED' };
  const profile = profileFor(input.apiVersion);
  const requested = { businessId: input.scope.businessId, invoiceId: input.scope.invoiceId, expectedAccountId: input.accountId };
  const base = { origin: 'MOCK_FIXTURE' as const, observedAtMs: input.observedAtMs, requested, accountId: verified(input.accountId, 'MOCK_FIXTURE', 'MOCK'), mode: verified('test' as const, 'MOCK_FIXTURE', 'MOCK') };
  const noFp = { status: null, dueMinor: null, paidMinor: null, remainingMinor: null, totalMinor: null, lineCount: null };
  const rest = { billingInterval: input.billingInterval === 'unresolved' ? unresolved<'month' | 'year'>('MOCK_INTERVAL_UNRESOLVED') : verified(input.billingInterval, 'MOCK_FIXTURE' as const, 'MOCK' as const),
    benefitItem: slot(input.benefitItem, 'MOCK_BENEFIT_ITEM_UNRESOLVED'), cancellation: input.cancellation === 'unresolved' ? unresolved<Exclude<CancellationEvidence, 'unknown'>>('MOCK_CANCELLATION_UNRESOLVED') : verified(input.cancellation, 'MOCK_FIXTURE' as const, 'MOCK' as const) };
  if (!profile) {
    // no mapping profile for this API version: nothing is mapped, nothing is read, everything is UNRESOLVED
    const u = unresolved<never>('API_VERSION_UNSUPPORTED');
    const facts = allUnresolved('API_VERSION_UNSUPPORTED');
    const evidence = await assembleEvidence({ ...base, facts, factsAfter: facts, fingerprintBefore: noFp, fingerprintAfter: noFp, invoiceContradictions: [], lineAttribution: u, settlingPayment: u, refunds: u, disputes: u, ...rest,
      schemaDrift: ['API_VERSION_UNSUPPORTED'] });
    return { ok: true, evidence: sealBundle(evidence, 'MOCK_FIXTURE') };
  }

  const a = normalizeInvoice(input.invoiceBefore, input.scope, input.observedAtMs, 'MOCK_FIXTURE', 'PROVIDER_SCHEMA');
  const b = normalizeInvoice(input.invoiceAfter ?? input.invoiceBefore, input.scope, input.observedAtMs, 'MOCK_FIXTURE', 'PROVIDER_SCHEMA');
  if (a.denied) return { ok: false, denied: a.denied };
  if (b.denied) return { ok: false, denied: b.denied };
  const f = a.facts;
  const drift: string[] = [];

  // lines (paged)
  const amounts = f.amounts.state === 'VERIFIED' ? f.amounts.value! : null;
  const lineN = f.currency.state === 'VERIFIED'
    ? normalizeLinePages(await input.source.listInvoiceLines(input.scope.invoiceId), { invoiceId: input.scope.invoiceId, currency: f.currency.value!, totalMinor: amounts ? amounts.totalMinor : null, profile }, { origin: 'MOCK_FIXTURE', frozen: input.frozen, idempotency: input.idempotency })
    : { lines: unresolved('INVOICE_CURRENCY_UNRESOLVED') as InvoiceFacts['lines'], attribution: unresolved('INVOICE_CURRENCY_UNRESOLVED') as Field<never>, drift: [] as string[] };
  drift.push(...lineN.drift);

  // the settling payment, and only then its refund and dispute history
  let payment: Field<SettlingPayment> = unresolved('INVOICE_CORE_UNRESOLVED');
  if (f.status.state === 'VERIFIED' && f.currency.state === 'VERIFIED' && f.createdAtMs.state === 'VERIFIED' && amounts) {
    const p = normalizeInvoicePayments(await input.source.listInvoicePayments(input.scope.invoiceId),
      { invoiceId: input.scope.invoiceId, currency: f.currency.value!, invoiceStatus: f.status.value!, invoicePaidMinor: amounts.paidMinor, invoiceCreatedAtMs: f.createdAtMs.value!, observedAtMs: input.observedAtMs, profile }, 'MOCK_FIXTURE');
    payment = p.payment; drift.push(...p.drift);
  }
  let refunds: Field<{ items: readonly MockRefund[] }> = unresolved('PAYMENT_TARGET_UNKNOWN');
  let disputes: Field<{ items: readonly MockPaymentDispute[] }> = unresolved('PAYMENT_TARGET_UNKNOWN');
  if (payment.state === 'VERIFIED' && payment.value!.details && amounts && f.currency.state === 'VERIFIED') {
    const target: PaymentTarget = { kind: payment.value!.details.kind, ref: payment.value!.ref };
    const ctx = { businessId: input.scope.businessId, invoiceId: input.scope.invoiceId, paymentRef: payment.value!.ref, target, currency: f.currency.value!, paidMinor: amounts.paidMinor, profile };
    const r = normalizeRefundPages(await input.source.listRefunds(target), ctx, 'MOCK_FIXTURE');
    const d = normalizeDisputePages(await input.source.listDisputes(target), ctx, 'MOCK_FIXTURE');
    refunds = r.refunds; disputes = d.disputes; drift.push(...r.drift, ...d.drift);
  }
  const facts: InvoiceFacts = { ...f, lines: lineN.lines };
  const factsAfter: InvoiceFacts = { ...b.facts, lines: lineN.lines };
  const evidence = await assembleEvidence({
    ...base, facts, factsAfter, fingerprintBefore: a.fingerprint, fingerprintAfter: b.fingerprint, invoiceContradictions: a.contradictions,
    lineAttribution: lineN.attribution, settlingPayment: payment, refunds, disputes, ...rest, schemaDrift: drift, extraContradictions: crossCheckHistories(refunds, disputes),
  });
  return { ok: true, evidence: sealBundle(evidence, 'MOCK_FIXTURE') };
}
