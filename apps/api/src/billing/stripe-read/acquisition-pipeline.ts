import type { InvocationDependencies, InvocationPolicy } from '../private-stripe-verifier-invocation.contract';
import { acquireEvidence } from './evidence-engine';
import { sealedOriginOf } from './evidence-origin';
import type { EvidenceOrigin, FieldState, NormalizedStripeEvidence } from './evidence-types';
import type { TrustedInvoiceScope } from './invoice-normalizer';
import type { FrozenReference } from './line-normalizer';
import type { ReadProvider } from './read-provider';
import type { AuditSink } from './read-types';
import { classifyBundle, type BundleClassification, type ClassifierBinding } from './classifier-bridge';
import { checkEvidenceRequest, TrustedStripeEvidenceService, type EvidenceRequest, type InvocationPair, type ServiceDenial } from './trusted-evidence-service';
import type { FailureClass } from './capability-registry';
import type { RefundDisputeContext } from '../refund-dispute.classifier';
import type { MockSettlementEvidence, SettlementClassifierContext } from '../settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-08: the unified evidence ACQUISITION PIPELINE.
 *
 *   trusted business + invoice ids
 *     -> persisted tenant binding (resolveBinding)           [cross-tenant / unknown invoice: refused]
 *     -> private-verifier invocation contract (real reads)    [required for real, not for fixtures]
 *     -> evidence engine over ONE ReadProvider                [capability registry, GET-only transport, normalizers]
 *     -> completeness, freshness and origin evaluation        [any blocker: REJECTED, nothing reaches a classifier]
 *     -> existing D1 and D3 classifier bridge                 [mock evidence only]
 *
 * A caller can send a business id and an invoice id and nothing else: no verdict, completeness, mode, account or "verified" flag is accepted. The pipeline performs no database write,
 * records no authorization, moves no credit and exposes no provider client. `recordableEvidence` is the classifier-shaped MOCK evidence a signed recorder could be handed; it exists only
 * for sealed MOCK_FIXTURE bundles, so evidence from a real read can neither be recorded nor consumed. Which provider is used is fixed at construction.
 */
export interface AcquisitionConfig {
  /** Freshness window F (Q3, undecided). No default: null means evidence freshness cannot be established and every acquisition is rejected. */
  readonly freshnessWindowMs: number | null;
  /** Instant PC-BENEFIT/1 applies from (Q14, undecided). Passed to the classifier as-is; null makes the classifier answer UNRESOLVED. */
  readonly policyEffectiveFromMs: number | null;
  readonly policyVersion: string | null;
}

/** Everything the pipeline trusts, read from PERSISTED, tenant-checked records. Never from the caller and never from a provider response. */
export interface AcquisitionBinding {
  readonly scope: TrustedInvoiceScope;
  readonly expectedAccountId: string;
  readonly classifier: Readonly<{
    binding: ClassifierBinding;
    expected: SettlementClassifierContext['expected'];
    /** The persisted settling-payment reference, when one is recorded. Without it the D3 classifier is not run (it would only compare the provider with itself). */
    expectedPaymentRef: string | null;
    consumedAtMs: number | null;
  }>;
}

export type Blocker =
  | 'EVIDENCE_INCOMPLETE' | 'EVIDENCE_CONTRADICTORY' | 'SCHEMA_DRIFT' | 'REAL_EVIDENCE_NOT_AUTHORIZED_FOR_SETTLEMENT' | 'EVIDENCE_ORIGIN_UNTRUSTED'
  | 'FRESHNESS_POLICY_UNAVAILABLE' | 'EVIDENCE_FROM_FUTURE' | 'STALE_EVIDENCE';
export type Category = 'account' | 'mode' | 'invoice' | 'invoice_lines' | 'line_attribution' | 'settling_payment' | 'refund_history' | 'dispute_history' | 'billing_interval' | 'benefit_item' | 'cancellation' | 'bracketing_reads';
export interface CompletenessReport {
  readonly complete: boolean;
  readonly categories: Readonly<Record<Category, FieldState>>;
  /** Categories that are not positively established (UNRESOLVED or CONTRADICTORY), with the reason the evidence gave. */
  readonly unresolved: readonly { readonly category: Category; readonly state: FieldState; readonly reason: string | null }[];
  readonly contradictions: readonly string[];
  readonly schemaDrift: readonly string[];
  readonly freshness: 'FRESH' | 'STALE' | 'FROM_FUTURE' | 'UNAVAILABLE';
  readonly blockers: readonly Blocker[];
}
export type PipelineResult =
  | Readonly<{ status: 'CLASSIFIED'; origin: EvidenceOrigin; evidence: NormalizedStripeEvidence; completeness: CompletenessReport; classification: BundleClassification; recordableEvidence: MockSettlementEvidence | null }>
  | Readonly<{ status: 'REJECTED'; origin: EvidenceOrigin; evidence: NormalizedStripeEvidence; completeness: CompletenessReport; classification: BundleClassification | null }>
  | Readonly<{ status: 'DENIED'; reason: ServiceDenial }>
  | Readonly<{ status: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;

const age = (e: NormalizedStripeEvidence, nowMs: number, window: number | null): CompletenessReport['freshness'] =>
  window === null || !Number.isSafeInteger(window) || window < 0 || !Number.isSafeInteger(e.observedAtMs) ? 'UNAVAILABLE' : nowMs - e.observedAtMs < 0 ? 'FROM_FUTURE' : nowMs - e.observedAtMs > window ? 'STALE' : 'FRESH';

/** Pure evaluation of a bundle: which categories are established, what blocks positive authority. */
export function evaluateCompleteness(e: NormalizedStripeEvidence, nowMs: number, freshnessWindowMs: number | null, sealedOrigin: EvidenceOrigin | null): CompletenessReport {
  const i = e.invoice;
  const fields: Array<[Category, { state: FieldState; reason: string | null }]> = [
    ['account', e.accountId], ['mode', e.mode], ['invoice', i.status], ['invoice_lines', i.lines], ['line_attribution', e.lineAttribution], ['settling_payment', e.settlingPayment],
    ['refund_history', e.refunds], ['dispute_history', e.disputes], ['billing_interval', e.billingInterval], ['benefit_item', e.benefitItem], ['cancellation', e.cancellation], ['bracketing_reads', e.stable],
  ];
  const invoiceFacts = [i.id, i.status, i.currency, i.customerRef, i.subscriptionRef, i.createdAtMs, i.paidAtMs, i.voidedAtMs, i.amounts];
  const invoiceState: FieldState = invoiceFacts.some(f => f.state === 'CONTRADICTORY') ? 'CONTRADICTORY' : invoiceFacts.some(f => f.state === 'UNRESOLVED') ? 'UNRESOLVED' : 'VERIFIED';
  const categories = Object.fromEntries(fields.map(([c, f]) => [c, c === 'invoice' ? invoiceState : f.state])) as Record<Category, FieldState>;
  const unresolved = fields.filter(([c, f]) => (c === 'invoice' ? invoiceState : f.state) !== 'VERIFIED' && (c === 'invoice' ? invoiceState : f.state) !== 'CONFIRMED_ABSENT')
    .map(([c, f]) => ({ category: c, state: (c === 'invoice' ? invoiceState : f.state) as FieldState, reason: f.reason }));
  const freshness = age(e, nowMs, freshnessWindowMs);
  const blockers: Blocker[] = [];
  if (!e.complete) blockers.push('EVIDENCE_INCOMPLETE');
  if (e.contradictions.length > 0) blockers.push('EVIDENCE_CONTRADICTORY');
  if (e.schemaDrift.length > 0) blockers.push('SCHEMA_DRIFT');
  if (sealedOrigin === null || sealedOrigin !== e.origin) blockers.push('EVIDENCE_ORIGIN_UNTRUSTED');
  else if (sealedOrigin === 'STRIPE_TEST_READ') blockers.push('REAL_EVIDENCE_NOT_AUTHORIZED_FOR_SETTLEMENT');
  if (freshness === 'UNAVAILABLE') blockers.push('FRESHNESS_POLICY_UNAVAILABLE'); else if (freshness === 'FROM_FUTURE') blockers.push('EVIDENCE_FROM_FUTURE'); else if (freshness === 'STALE') blockers.push('STALE_EVIDENCE');
  return { complete: e.complete, categories, unresolved, contradictions: e.contradictions, schemaDrift: e.schemaDrift, freshness, blockers };
}

export class EvidenceAcquisitionPipeline<Proof = never> {
  constructor(private readonly d: Readonly<{
    provider: ReadProvider;
    config: AcquisitionConfig;
    resolveBinding: (businessId: string, invoiceId: string) => Promise<AcquisitionBinding | null>;
    clock: () => number;
    audit: AuditSink;
    /** Private-verifier invocation policy and dependencies. Required when the provider is real; a fixture provider may run without them. */
    invocation?: Readonly<{ policy: InvocationPolicy | null; deps: InvocationDependencies<Proof> }>;
  }>) {}

  async run(request: EvidenceRequest, invocations?: InvocationPair<Proof>): Promise<PipelineResult> {
    try {
      const bad = checkEvidenceRequest(request);
      if (bad) return { status: 'DENIED', reason: bad };
      let binding: AcquisitionBinding | null;
      try { binding = await this.d.resolveBinding(request.businessId, request.invoiceId); } catch { return { status: 'DENIED', reason: 'DEPENDENCY_UNAVAILABLE' }; }
      if (!binding || binding.scope.businessId !== request.businessId || binding.scope.invoiceId !== request.invoiceId || binding.classifier.binding.businessId !== request.businessId) return { status: 'DENIED', reason: 'TENANT_MISMATCH' };

      const frozen: FrozenReference[] = binding.classifier.expected.frozenAllocation.allocations.map(a => ({ reservationId: a.reservationId, providerIdempotencyKey: a.providerIdempotencyKey, benefitMinor: a.benefitMinor }));
      const engineDeps = { provider: this.d.provider, clock: this.d.clock, audit: this.d.audit };
      const service = new TrustedStripeEvidenceService<Proof>({
        adapter: { kind: this.d.provider.kind, acquire: scope => acquireEvidence(engineDeps, scope, binding!.expectedAccountId, frozen) },
        policy: this.d.invocation?.policy ?? null, invocation: this.d.invocation?.deps ?? null,
        resolveScope: async () => binding!.scope, clock: this.d.clock,
      });
      const got = await service.readInvoiceEvidence({ businessId: request.businessId, invoiceId: request.invoiceId }, invocations);
      if (got.status === 'DENIED') return { status: 'DENIED', reason: got.reason };
      if (got.status === 'PROVIDER_FAILURE') return { status: 'PROVIDER_FAILURE', failureClass: got.failureClass };

      const now = this.d.clock(); const evidence = got.evidence;
      const sealed = sealedOriginOf(evidence);
      const completeness = evaluateCompleteness(evidence, now, this.d.config.freshnessWindowMs, sealed);
      const c = binding.classifier;
      const ctx: SettlementClassifierContext = { nowMs: now, policy: { version: this.d.config.policyVersion, effectiveFromMs: this.d.config.policyEffectiveFromMs, freshnessWindowMs: this.d.config.freshnessWindowMs }, expected: c.expected };
      const rd: RefundDisputeContext | null = c.expectedPaymentRef === null ? null : {
        nowMs: now, policy: { version: this.d.config.policyVersion, freshnessWindowMs: this.d.config.freshnessWindowMs },
        expected: { businessId: c.binding.businessId, invoiceRef: c.expected.invoiceRef, paymentRef: c.expectedPaymentRef, currency: c.expected.currency, providerAccountId: c.expected.providerAccountId, providerMode: c.expected.providerMode, consumedAtMs: c.consumedAtMs },
      };
      if (completeness.blockers.length > 0) {
        // nothing reaches the recordable path; a real bundle is still shown to the classifiers so the refusal is the classifiers' own (EVIDENCE_KIND_UNSUPPORTED)
        return { status: 'REJECTED', origin: evidence.origin, evidence, completeness, classification: sealed === 'STRIPE_TEST_READ' ? classifyBundle(ctx, evidence, c.binding, rd) : null };
      }
      const classification = classifyBundle(ctx, evidence, c.binding, rd);
      return { status: 'CLASSIFIED', origin: evidence.origin, evidence, completeness, classification, recordableEvidence: classification.origin === 'MOCK_FIXTURE' ? classification.settlementEvidence : null };
    } catch {
      return { status: 'DENIED', reason: 'DEPENDENCY_UNAVAILABLE' }; // nothing thrown here ever reaches a caller with detail
    }
  }
}
