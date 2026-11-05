import {
  contradictory, established, unresolved, verified,
  type EvidenceOrigin, type Field, type InvoiceFacts, type MockLineAttribution, type NormalizedStripeEvidence, type SettlingPayment,
} from './evidence-types';
import type { InvoiceFingerprint } from './invoice-normalizer';
import type { MockPaymentDispute, MockRefund } from '../refund-dispute.classifier';
import type { CancellationEvidence, MockBenefitItem } from '../settlement-eligibility.classifier';

/** Deterministic JSON: object keys sorted, so equal content gives equal bytes (the basis of the idempotent digest). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
export async function sha256Hex(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}

export interface BundleParts {
  readonly origin: EvidenceOrigin;
  readonly observedAtMs: number;
  readonly requested: NormalizedStripeEvidence['requested'];
  readonly accountId: Field<string>;
  readonly mode: Field<'test'>;
  readonly facts: InvoiceFacts;
  readonly factsAfter: InvoiceFacts;
  readonly fingerprintBefore: InvoiceFingerprint;
  readonly fingerprintAfter: InvoiceFingerprint;
  readonly invoiceContradictions: readonly string[];
  readonly lineAttribution: Field<readonly MockLineAttribution[]>;
  readonly billingInterval: Field<'month' | 'year'>;
  readonly benefitItem: Field<MockBenefitItem>;
  readonly cancellation: Field<Exclude<CancellationEvidence, 'unknown'>>;
  readonly settlingPayment: Field<SettlingPayment>;
  readonly refunds: Field<Readonly<{ items: readonly MockRefund[] }>>;
  readonly disputes: Field<Readonly<{ items: readonly MockPaymentDispute[] }>>;
}

/** Assembles the normalized evidence. `complete` and `stable` are COMPUTED here; nothing in the parts can assert them. */
export async function assembleEvidence(p: BundleParts): Promise<NormalizedStripeEvidence> {
  const contradictions = [...p.invoiceContradictions];
  const fpEqual = canonicalJson(p.fingerprintBefore) === canonicalJson(p.fingerprintAfter);
  const sameFacts = canonicalJson(p.facts) === canonicalJson(p.factsAfter);
  let stable: Field<true>;
  if (fpEqual && sameFacts) stable = verified(true as const, p.origin, 'PROVIDER_SCHEMA');
  else { contradictions.push('EVIDENCE_UNSTABLE'); stable = contradictory<true>('EVIDENCE_UNSTABLE'); }
  for (const f of [p.refunds, p.disputes, p.settlingPayment, p.lineAttribution, p.billingInterval, p.benefitItem, p.cancellation]) if (f.state === 'CONTRADICTORY' && f.reason) contradictions.push(f.reason);
  const i = p.facts;
  const required: Array<Field<unknown>> = [p.accountId, p.mode, i.id, i.status, i.currency, i.customerRef, i.subscriptionRef, i.createdAtMs, i.paidAtMs, i.voidedAtMs, i.amounts, i.lines,
    p.lineAttribution, p.billingInterval, p.benefitItem, p.cancellation, p.settlingPayment, p.refunds, p.disputes, stable];
  const complete = contradictions.length === 0 && required.every(f => established(f));
  const body = {
    origin: p.origin, observedAtMs: p.observedAtMs, requested: p.requested, accountId: p.accountId, mode: p.mode, invoice: p.facts, lineAttribution: p.lineAttribution,
    billingInterval: p.billingInterval, benefitItem: p.benefitItem, cancellation: p.cancellation, settlingPayment: p.settlingPayment, refunds: p.refunds, disputes: p.disputes, stable, contradictions, complete,
  };
  // The digest excludes observedAtMs on purpose: two reads of unchanged provider state taken at different instants are the SAME evidence (idempotent duplicate retrieval).
  const { observedAtMs: _observed, ...digestBody } = body;
  void _observed;
  const digest = await sha256Hex(canonicalJson(digestBody));
  return { ...body, invoice: p.facts, contradictions: Object.freeze(contradictions), digest };
}

export const NO_REAL_MAPPING = Object.freeze({
  lineAttribution: unresolved<readonly MockLineAttribution[]>('LINE_ATTRIBUTION_MAPPING_UNSUPPORTED (Q1/Q2: no source-supported provider field for category, parent item or parent idempotency key)'),
  billingInterval: unresolved<'month' | 'year'>('BILLING_INTERVAL_MAPPING_UNSUPPORTED (Q1/Q2)'),
  benefitItem: unresolved<MockBenefitItem>('INVOICE_ITEM_READ_NOT_AUTHORIZED (Q1/Q2)'),
  cancellation: unresolved<Exclude<CancellationEvidence, 'unknown'>>('SUBSCRIPTION_READ_NOT_AUTHORIZED (Q1/Q2)'),
  settlingPayment: unresolved<SettlingPayment>('PAYMENT_READ_NOT_AUTHORIZED (Q1/Q2: PAYMENT_RETRIEVE is disabled)'),
  refunds: unresolved<Readonly<{ items: readonly MockRefund[] }>>('REFUNDS_READ_NOT_AUTHORIZED (Q1/Q2: REFUNDS_LIST is disabled)'),
  disputes: unresolved<Readonly<{ items: readonly MockPaymentDispute[] }>>('DISPUTES_READ_NOT_AUTHORIZED (Q1/Q2: DISPUTES_LIST is disabled)'),
});
