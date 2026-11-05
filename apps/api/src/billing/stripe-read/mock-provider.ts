import { assembleEvidence } from './bundle-builder';
import { sealBundle } from './evidence-origin';
import { confirmedAbsent, unresolved, verified, type Field, type MockLineAttribution, type NormalizedStripeEvidence, type SettlingPayment } from './evidence-types';
import { normalizeInvoice, type NormalizeDenial, type TrustedInvoiceScope } from './invoice-normalizer';
import { ProviderReadError, type PerformableMethod, type StripeReadTransport } from './transport';
import type { FailureClass } from './capability-registry';
import type { MockPaymentDispute, MockRefund } from '../refund-dispute.classifier';
import type { CancellationEvidence, MockBenefitItem } from '../settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-06: DEVELOPMENT mock provider. It exercises the same normalizer and assembler as the real adapter, but its evidence is sealed `MOCK_FIXTURE`, and the classifier
 * bridge will only ever hand `MOCK_FIXTURE` evidence to the classifiers (which themselves accept nothing but the mock evidence kind). It contains the full anticipated evidence
 * set (payment, refunds, disputes, line attribution, benefit item, cancellation) because the real reads for them are not authorized. Nothing here can become "authentic Stripe
 * evidence": the seal is by object identity.
 */
export type Slot<T> = T | 'absent' | 'unresolved';
export interface MockEvidenceSpec {
  readonly scope: TrustedInvoiceScope;
  readonly accountId: string;
  readonly observedAtMs: number;
  /** Raw synthetic invoice in the same shape as a Stripe test-mode invoice (livemode false). */
  readonly invoiceBefore: unknown;
  readonly invoiceAfter?: unknown;
  readonly lineAttribution: Slot<readonly MockLineAttribution[]>;
  readonly billingInterval: 'month' | 'year' | 'unresolved';
  readonly benefitItem: Slot<MockBenefitItem>;
  readonly cancellation: Exclude<CancellationEvidence, 'unknown'> | 'unresolved';
  readonly settlingPayment: Slot<SettlingPayment>;
  readonly refunds: Slot<readonly MockRefund[]>;
  readonly disputes: Slot<readonly MockPaymentDispute[]>;
}

const slot = <T>(v: Slot<T>, reasonIfUnresolved: string): Field<T> =>
  v === 'unresolved' ? unresolved<T>(reasonIfUnresolved) : v === 'absent' ? confirmedAbsent<T>('MOCK_FIXTURE', 'MOCK') : verified(v, 'MOCK_FIXTURE', 'MOCK');

export async function buildMockEvidence(spec: MockEvidenceSpec): Promise<{ ok: true; evidence: NormalizedStripeEvidence } | { ok: false; denied: NormalizeDenial }> {
  const a = normalizeInvoice(spec.invoiceBefore, spec.scope, spec.observedAtMs, 'MOCK_FIXTURE', 'MOCK');
  const b = normalizeInvoice(spec.invoiceAfter ?? spec.invoiceBefore, spec.scope, spec.observedAtMs, 'MOCK_FIXTURE', 'MOCK');
  if (a.denied) return { ok: false, denied: a.denied };
  if (b.denied) return { ok: false, denied: b.denied };
  const refunds: Field<{ items: readonly MockRefund[] }> = spec.refunds === 'unresolved' ? unresolved('MOCK_REFUNDS_UNRESOLVED') : spec.refunds === 'absent' ? confirmedAbsent('MOCK_FIXTURE', 'MOCK') : verified({ items: spec.refunds }, 'MOCK_FIXTURE', 'MOCK');
  const disputes: Field<{ items: readonly MockPaymentDispute[] }> = spec.disputes === 'unresolved' ? unresolved('MOCK_DISPUTES_UNRESOLVED') : spec.disputes === 'absent' ? confirmedAbsent('MOCK_FIXTURE', 'MOCK') : verified({ items: spec.disputes }, 'MOCK_FIXTURE', 'MOCK');
  const evidence = await assembleEvidence({
    origin: 'MOCK_FIXTURE', observedAtMs: spec.observedAtMs, requested: { businessId: spec.scope.businessId, invoiceId: spec.scope.invoiceId, expectedAccountId: spec.accountId },
    accountId: verified(spec.accountId, 'MOCK_FIXTURE', 'MOCK'), mode: verified('test' as const, 'MOCK_FIXTURE', 'MOCK'),
    facts: a.facts, factsAfter: b.facts, fingerprintBefore: a.fingerprint, fingerprintAfter: b.fingerprint, invoiceContradictions: a.contradictions,
    lineAttribution: slot(spec.lineAttribution === 'absent' ? 'unresolved' : spec.lineAttribution, 'MOCK_LINE_ATTRIBUTION_UNRESOLVED'),
    billingInterval: spec.billingInterval === 'unresolved' ? unresolved('MOCK_INTERVAL_UNRESOLVED') : verified(spec.billingInterval, 'MOCK_FIXTURE', 'MOCK'),
    benefitItem: slot(spec.benefitItem, 'MOCK_BENEFIT_ITEM_UNRESOLVED'),
    cancellation: spec.cancellation === 'unresolved' ? unresolved('MOCK_CANCELLATION_UNRESOLVED') : verified(spec.cancellation, 'MOCK_FIXTURE', 'MOCK'),
    settlingPayment: slot(spec.settlingPayment, 'MOCK_PAYMENT_UNRESOLVED'), refunds, disputes,
  });
  return { ok: true, evidence: sealBundle(evidence, 'MOCK_FIXTURE') };
}

/** A well-formed synthetic Stripe-shaped invoice. `over` replaces top-level keys (use it to make malformed or contradictory variants). */
export function syntheticStripeInvoice(scope: TrustedInvoiceScope, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: scope.invoiceId, object: 'invoice', livemode: false, currency: 'usd', status: 'paid', customer: scope.customerId,
    parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: scope.subscriptionId } },
    amount_due: 9700, amount_paid: 9700, amount_remaining: 0, total: 9700, created: 1_700_000_000,
    status_transitions: { finalized_at: 1_700_000_001, marked_uncollectible_at: null, paid_at: 1_700_000_100, voided_at: null },
    lines: { object: 'list', has_more: false, data: [{ id: 'il_base', object: 'line_item', amount: 10000, currency: 'usd' }, { id: 'il_benefit', object: 'line_item', amount: -300, currency: 'usd' }] },
    ...over,
  };
}

/**
 * A scripted transport for tests: it records every call and can fail with a classed provider error. `responses[0]` answers every account read; the rest answer invoice reads in order
 * and the last one repeats. It can only receive the two GET method ids, so it cannot express a write.
 */
export class ScriptedReadTransport implements StripeReadTransport {
  readonly keyMode = 'test' as const;
  readonly calls: Array<{ method: PerformableMethod; invoiceId: string | null }> = [];
  private invoiceReads = 0;
  constructor(private readonly responses: Array<unknown | { throws: FailureClass }>) {}
  async get(method: PerformableMethod, params?: Readonly<{ invoiceId?: string }>): Promise<unknown> {
    this.calls.push({ method, invoiceId: params?.invoiceId ?? null });
    const next = method === 'ACCOUNT_RETRIEVE_CURRENT' ? this.responses[0] : this.responses.length > 1 ? this.responses[Math.min(1 + this.invoiceReads++, this.responses.length - 1)] : this.responses[0];
    if (next && typeof next === 'object' && 'throws' in (next as object)) throw new ProviderReadError((next as { throws: FailureClass }).throws);
    return next;
  }
}
