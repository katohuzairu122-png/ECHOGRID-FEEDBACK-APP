import { assembleEvidence, NO_REAL_MAPPING } from './bundle-builder';
import { sealBundle } from './evidence-origin';
import { confirmedAbsent, unresolved, verified, type Field, type InvoiceFacts, type MockLineAttribution, type SettlingPayment } from './evidence-types';
import { normalizeInvoice, type TrustedInvoiceScope } from './invoice-normalizer';
import { normalizeLinePages, type FrozenReference } from './line-normalizer';
import { normalizeInvoicePayments } from './payment-normalizer';
import { profileFor, type ProviderProfile } from './provider-profiles';
import type { AuditScope, ListRead, ReadProvider, Slot } from './read-provider';
import { makeEmitter, type AcquireOutcome, type AuditSink } from './read-types';
import { crossCheckHistories, normalizeDisputePages, normalizeRefundPages, type PaymentTarget } from './refund-dispute-normalizer';
import type { MockPaymentDispute, MockRefund } from '../refund-dispute.classifier';
import type { CancellationEvidence, MockBenefitItem } from '../settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-08: THE evidence acquisition engine. One implementation of the full retrieval sequence, used for every provider:
 *   account -> invoice (two bracketing reads) -> invoice-line pages -> settling payment -> refund history -> dispute history -> supplement -> normalize -> assemble -> seal.
 *
 * The engine knows nothing about Stripe's transport, credentials or fixtures: it talks to a `ReadProvider`. It decides nothing about eligibility and calls no classifier. Every read
 * outcome is a value; a provider failure ends the acquisition with a safe failure class and no evidence; a denied or unauthorized read leaves exactly its category UNRESOLVED.
 */
export interface EngineDeps {
  readonly provider: ReadProvider;
  readonly clock: () => number;
  readonly audit: AuditSink;
  /** With no mapping profile for the provider's API version: refuse (default) or return a bundle whose every fact is UNRESOLVED. */
  readonly onUnsupportedVersion?: 'DENY' | 'UNRESOLVED';
}

const allUnresolved = (reason: string): InvoiceFacts => ({
  id: unresolved(reason), status: unresolved(reason), currency: unresolved(reason), customerRef: unresolved(reason), subscriptionRef: unresolved(reason), createdAtMs: unresolved(reason),
  paidAtMs: unresolved(reason), voidedAtMs: unresolved(reason), amounts: unresolved(reason), lines: unresolved(reason),
});
const slot = <T>(v: Slot<T>, reason: string, origin: 'MOCK_FIXTURE' | 'STRIPE_TEST_READ'): Field<T> => (v === 'unresolved' ? unresolved<T>(reason) : v === 'absent' ? confirmedAbsent<T>(origin, 'PROVIDER_SCHEMA') : verified(v, origin, 'PROVIDER_SCHEMA'));

export async function acquireEvidence(deps: EngineDeps, scope: TrustedInvoiceScope, expectedAccountId: string, frozen: readonly FrozenReference[] | null): Promise<AcquireOutcome> {
  const { provider } = deps;
  const emit = makeEmitter(deps.audit, deps.clock, provider.kind);
  const audit: AuditScope = { businessId: scope?.businessId as string, invoiceId: scope?.invoiceId as string, accountId: expectedAccountId };
  if (!scope || typeof scope !== 'object' || typeof expectedAccountId !== 'string' || expectedAccountId.length === 0) {
    emit('stripe_read.denied', 'UNKNOWN', 'INVALID_REQUEST', null);
    return { ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' };
  }
  const profile: ProviderProfile | null = profileFor(provider.apiVersion);
  const supplement = await provider.supplement(audit);
  const interval = supplement.billingInterval === 'unresolved' ? unresolved<'month' | 'year'>(NO_REAL_MAPPING.billingInterval.reason ?? 'BILLING_INTERVAL_UNRESOLVED') : verified(supplement.billingInterval, provider.kind, 'PROVIDER_SCHEMA');
  const rest = {
    billingInterval: provider.kind === 'STRIPE_TEST_READ' ? NO_REAL_MAPPING.billingInterval : interval,
    benefitItem: provider.kind === 'STRIPE_TEST_READ' ? NO_REAL_MAPPING.benefitItem : slot<MockBenefitItem>(supplement.benefitItem, 'BENEFIT_ITEM_UNRESOLVED', provider.kind),
    cancellation: provider.kind === 'STRIPE_TEST_READ' ? NO_REAL_MAPPING.cancellation
      : supplement.cancellation === 'unresolved' ? unresolved<Exclude<CancellationEvidence, 'unknown'>>('CANCELLATION_UNRESOLVED') : verified(supplement.cancellation, provider.kind, 'PROVIDER_SCHEMA'),
  };

  if (!profile) {
    if ((deps.onUnsupportedVersion ?? 'DENY') === 'DENY') { emit('stripe_read.denied', 'UNKNOWN', 'UNSUPPORTED_API_VERSION', audit); return { ok: false, kind: 'DENIED', reason: 'UNSUPPORTED_API_VERSION' }; }
    // nothing is read and nothing is mapped: every fact is UNRESOLVED
    const u = unresolved<never>('API_VERSION_UNSUPPORTED'); const facts = allUnresolved('API_VERSION_UNSUPPORTED');
    const noFp = { status: null, dueMinor: null, paidMinor: null, remainingMinor: null, totalMinor: null, lineCount: null };
    const evidence = await assembleEvidence({ origin: provider.kind, observedAtMs: deps.clock(), requested: { businessId: scope.businessId, invoiceId: scope.invoiceId, expectedAccountId },
      accountId: verified(expectedAccountId, provider.kind, 'PROVIDER_SCHEMA'), mode: verified('test' as const, provider.kind, 'PROVIDER_SCHEMA'), facts, factsAfter: facts, fingerprintBefore: noFp, fingerprintAfter: noFp,
      invoiceContradictions: [], lineAttribution: u, settlingPayment: u, refunds: u, disputes: u, ...rest, schemaDrift: ['API_VERSION_UNSUPPORTED'] });
    return { ok: true, evidence: sealBundle(evidence, provider.kind) };
  }

  const pre = await provider.preflight({ ...audit, customerId: scope.customerId, subscriptionId: scope.subscriptionId });
  if (!pre.ok) return { ok: false, kind: 'DENIED', reason: pre.reason };

  // 1. the account the credential belongs to must be the expected one, before any invoice is requested
  const accountRead = await provider.getAccount(audit);
  if (!accountRead.ok) return accountRead.kind === 'DENIED' ? { ok: false, kind: 'DENIED', reason: accountRead.reason } : { ok: false, kind: 'PROVIDER_FAILURE', failureClass: accountRead.failureClass };
  const acct = accountRead.body as { object?: unknown; id?: unknown } | null;
  if (!acct || typeof acct !== 'object' || acct.object !== 'account' || typeof acct.id !== 'string') { emit('stripe_read.denied', 'ACCOUNT_RETRIEVE_CURRENT', 'ACCOUNT_RESPONSE_INVALID', audit); return { ok: false, kind: 'DENIED', reason: 'ACCOUNT_RESPONSE_INVALID' }; }
  if (acct.id !== expectedAccountId) { emit('stripe_read.denied', 'ACCOUNT_RETRIEVE_CURRENT', 'ACCOUNT_MISMATCH', audit); return { ok: false, kind: 'DENIED', reason: 'ACCOUNT_MISMATCH' }; }
  emit('stripe_read.success', 'ACCOUNT_RETRIEVE_CURRENT', null, audit);

  // 2. the invoice, read before and after (the bracketing reads the classifier requires)
  const bodies: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await provider.getInvoice(audit);
    if (!r.ok) return r.kind === 'DENIED' ? { ok: false, kind: 'DENIED', reason: r.reason } : { ok: false, kind: 'PROVIDER_FAILURE', failureClass: r.failureClass };
    bodies.push(r.body);
  }
  const observedAtMs = deps.clock(); // the trusted server clock, taken after the reads; never copied from a response
  const [a, b] = bodies.map(x => normalizeInvoice(x, scope, observedAtMs, provider.kind, 'PROVIDER_SCHEMA'));
  for (const n of [a!, b!]) if (n.denied) { emit('stripe_read.denied', 'INVOICE_RETRIEVE', n.denied, audit); return { ok: false, kind: 'DENIED', reason: n.denied }; }
  if (a!.denied !== null || b!.denied !== null) return { ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' };
  emit('stripe_read.success', 'INVOICE_RETRIEVE', null, audit);

  const f = a!.facts; const amounts = f.amounts.state === 'VERIFIED' ? f.amounts.value! : null;
  const drift: string[] = [];
  const noTarget = (r: ListRead) => !r.ok && r.kind === 'DENIED' && r.reason === 'NO_TARGET';
  const failure = (r: ListRead): AcquireOutcome | null => (r.ok || r.kind !== 'PROVIDER_FAILURE' ? null : { ok: false, kind: 'PROVIDER_FAILURE', failureClass: r.failureClass });

  // 3. invoice-line pages (when this provider is authorized to read them; otherwise only the invoice's own embedded first page stands, and attribution stays UNRESOLVED)
  let lines: InvoiceFacts['lines'] = f.lines; let attribution: Field<readonly MockLineAttribution[]> = NO_REAL_MAPPING.lineAttribution;
  if (f.currency.state === 'VERIFIED') {
    const r = await provider.listInvoiceLines(audit); const fail = failure(r); if (fail) return fail;
    if (r.ok) {
      const n = normalizeLinePages(r.pages, { invoiceId: scope.invoiceId, currency: f.currency.value!, totalMinor: amounts ? amounts.totalMinor : null, profile }, { origin: provider.kind, frozen, idempotency: supplement.idempotency });
      lines = n.lines; attribution = n.attribution; drift.push(...n.drift);
    }
  }

  // 4. the settling payment
  let payment: Field<SettlingPayment> = NO_REAL_MAPPING.settlingPayment;
  if (f.status.state === 'VERIFIED' && f.currency.state === 'VERIFIED' && f.createdAtMs.state === 'VERIFIED' && amounts) {
    const r = await provider.listInvoicePayments(audit); const fail = failure(r); if (fail) return fail;
    if (r.ok) {
      const p = normalizeInvoicePayments(r.pages, { invoiceId: scope.invoiceId, currency: f.currency.value!, invoiceStatus: f.status.value!, invoicePaidMinor: amounts.paidMinor, invoiceCreatedAtMs: f.createdAtMs.value!, observedAtMs, profile }, provider.kind);
      payment = p.payment; drift.push(...p.drift);
    }
  } else {
    // the read is still asked for (and audited as denied for providers that may not make it); the core invoice facts it depends on are unresolved
    const r = await provider.listInvoicePayments(audit); const fail = failure(r); if (fail) return fail;
    if (r.ok) payment = unresolved('INVOICE_CORE_UNRESOLVED');
  }

  // 5. refund and dispute history of that one payment
  const target: PaymentTarget | null = payment.state === 'VERIFIED' && payment.value!.details ? { kind: payment.value!.details.kind, ref: payment.value!.ref } : null;
  let refunds: Field<{ items: readonly MockRefund[] }> = NO_REAL_MAPPING.refunds; let disputes: Field<{ items: readonly MockPaymentDispute[] }> = NO_REAL_MAPPING.disputes;
  const rr = await provider.listRefunds(audit, target); const rf = failure(rr); if (rf) return rf;
  const dr = await provider.listDisputes(audit, target); const df = failure(dr); if (df) return df;
  if (!target) {
    if (rr.ok || noTarget(rr)) refunds = unresolved('PAYMENT_TARGET_UNKNOWN');
    if (dr.ok || noTarget(dr)) disputes = unresolved('PAYMENT_TARGET_UNKNOWN');
  } else if (amounts && f.currency.state === 'VERIFIED') {
    const ctx = { businessId: scope.businessId, invoiceId: scope.invoiceId, paymentRef: payment.value!.ref, target, currency: f.currency.value!, paidMinor: amounts.paidMinor, profile };
    if (rr.ok) { const n = normalizeRefundPages(rr.pages, ctx, provider.kind); refunds = n.refunds; drift.push(...n.drift); }
    if (dr.ok) { const n = normalizeDisputePages(dr.pages, ctx, provider.kind); disputes = n.disputes; drift.push(...n.drift); }
  }

  const facts: InvoiceFacts = { ...f, lines };
  const factsAfter: InvoiceFacts = { ...b!.facts, lines };
  const evidence = await assembleEvidence({
    origin: provider.kind, observedAtMs, requested: { businessId: scope.businessId, invoiceId: scope.invoiceId, expectedAccountId },
    accountId: verified(acct.id, provider.kind, 'PROVIDER_SCHEMA'),
    // test mode is proven by the credential's mode (fixed 'test' at construction) AND livemode=false on the invoice (a true value was a denial above)
    mode: verified('test' as const, provider.kind, 'PROVIDER_SCHEMA'),
    facts, factsAfter, fingerprintBefore: a!.fingerprint, fingerprintAfter: b!.fingerprint, invoiceContradictions: a!.contradictions,
    lineAttribution: attribution, settlingPayment: payment, refunds, disputes, ...rest, schemaDrift: drift, extraContradictions: crossCheckHistories(refunds, disputes),
  });
  return { ok: true, evidence: sealBundle(evidence, provider.kind) };
}
