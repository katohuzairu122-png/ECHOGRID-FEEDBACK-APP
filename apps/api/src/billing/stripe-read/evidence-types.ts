import type { MockRefund, MockPaymentDispute } from '../refund-dispute.classifier';
import type { LineCategory, MockBenefitItem, CancellationEvidence } from '../settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-06: typed evidence contracts. Every fact carries its own state, source and mapping status. The states are mutually exclusive and `UNRESOLVED` is the default for
 * anything that was not positively established: missing evidence (UNRESOLVED) and confirmed absence (CONFIRMED_ABSENT, only ever from a successful, complete read that
 * included the field) are different values, and neither can be produced from a caller assertion.
 */
/** Version of THIS evidence contract (field set, states and rules). Bumped when any of them changes. */
export const EVIDENCE_CONTRACT_VERSION = 'S08-STRIPE-EVIDENCE/1' as const;
export type FieldState = 'VERIFIED' | 'CONFIRMED_ABSENT' | 'UNRESOLVED' | 'CONTRADICTORY';
export type EvidenceOrigin = 'STRIPE_TEST_READ' | 'MOCK_FIXTURE';
/** PROVIDER_SCHEMA: the field name/shape is taken from the pinned Stripe SDK type definitions (shape only, NOT yet proven live: Q1/Q2). MOCK: a synthetic fixture. NONE: no mapping exists. */
export type MappingStatus = 'PROVIDER_SCHEMA' | 'MOCK' | 'NONE';

export interface Field<T> {
  readonly state: FieldState;
  readonly value: T | null;
  readonly origin: EvidenceOrigin | 'NONE';
  readonly mapping: MappingStatus;
  readonly reason: string | null;
}
export const verified = <T>(value: T, origin: EvidenceOrigin, mapping: MappingStatus): Field<T> => Object.freeze({ state: 'VERIFIED', value, origin, mapping, reason: null });
export const confirmedAbsent = <T>(origin: EvidenceOrigin, mapping: MappingStatus): Field<T> => Object.freeze({ state: 'CONFIRMED_ABSENT', value: null, origin, mapping, reason: null });
export const unresolved = <T>(reason: string): Field<T> => Object.freeze({ state: 'UNRESOLVED', value: null, origin: 'NONE', mapping: 'NONE', reason });
export const contradictory = <T>(reason: string): Field<T> => Object.freeze({ state: 'CONTRADICTORY', value: null, origin: 'NONE', mapping: 'NONE', reason });
/** A field is usable as a fact only if it was positively established. */
export const established = <T>(f: Field<T> | undefined): f is Field<T> => !!f && (f.state === 'VERIFIED' || f.state === 'CONFIRMED_ABSENT');

export type InvoiceStatusValue = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export interface NormalizedLine { readonly lineRef: string; readonly amountMinor: number; readonly currency: string }
export interface MockLineAttribution {
  readonly lineRef: string; readonly category: LineCategory; readonly parentItemRef: string | null; readonly parentItemKey: string | null;
  /** The untrusted metadata label, preserved for review only. Never evidence of attribution. */
  readonly labelReservationRef?: string | null;
}

export interface InvoiceFacts {
  readonly id: Field<string>;
  readonly status: Field<InvoiceStatusValue>;
  readonly currency: Field<string>;
  readonly customerRef: Field<string>;
  readonly subscriptionRef: Field<string>;
  readonly createdAtMs: Field<number>;
  /** CONFIRMED_ABSENT only when the provider response carried the key with a null value. */
  readonly paidAtMs: Field<number>;
  readonly voidedAtMs: Field<number>;
  readonly amounts: Field<Readonly<{ dueMinor: number; paidMinor: number; remainingMinor: number; totalMinor: number }>>;
  readonly lines: Field<Readonly<{ items: readonly NormalizedLine[]; pageComplete: boolean }>>;
}

/** Identity and amounts of the one payment that settled the invoice (present for evidence derived from a payment read). */
export interface PaymentDetails {
  /** The provider's invoice-payment record id. */
  readonly paymentRecordRef: string;
  readonly kind: 'payment_intent' | 'charge';
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidAtMs: number;
}
export interface SettlingPayment { readonly ref: string; readonly source: 'stripe_payment' | 'out_of_band'; readonly details?: PaymentDetails }

export interface NormalizedStripeEvidence {
  readonly contractVersion: typeof EVIDENCE_CONTRACT_VERSION;
  readonly origin: EvidenceOrigin;
  /** The trusted SERVER clock when the read finished. Never copied from a response or a caller. */
  readonly observedAtMs: number;
  readonly requested: Readonly<{ businessId: string; invoiceId: string; expectedAccountId: string }>;
  readonly accountId: Field<string>;
  readonly mode: Field<'test'>;
  readonly invoice: InvoiceFacts;
  /** Line attribution (category, parent item, parent idempotency key). No provider field is mapped for it yet (Q1/Q2): UNRESOLVED for real reads. */
  readonly lineAttribution: Field<readonly MockLineAttribution[]>;
  readonly billingInterval: Field<'month' | 'year'>;
  /** The benefit Invoice Item (needs an Invoice Item read: not authorized, so UNRESOLVED for real reads). */
  readonly benefitItem: Field<MockBenefitItem>;
  /** Subscription cancellation state (needs a subscription read: not authorized, so UNRESOLVED for real reads). */
  readonly cancellation: Field<Exclude<CancellationEvidence, 'unknown'>>;
  readonly settlingPayment: Field<SettlingPayment>;
  readonly refunds: Field<Readonly<{ items: readonly MockRefund[] }>>;
  readonly disputes: Field<Readonly<{ items: readonly MockPaymentDispute[] }>>;
  /** Stability across the two bracketing invoice reads. */
  readonly stable: Field<true>;
  readonly contradictions: readonly string[];
  /** Schema drift seen while normalizing (unknown enum values, wrong types, unsupported API version). Drifted facts are UNRESOLVED; this list is for diagnosis and also prevents completeness. */
  readonly schemaDrift: readonly string[];
  /** Computed here from the fields, never taken from a caller or the provider. True only when every category is positively established and nothing contradicts. */
  readonly complete: boolean;
  /** SHA-256 of the canonical normalized content: equal inputs give equal digests (duplicate retrieval is idempotent). */
  readonly digest: string;
}
