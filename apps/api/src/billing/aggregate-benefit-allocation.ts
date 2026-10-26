import { INVOICE_BENEFIT_POLICY_V1, type InvoiceBenefitResult } from './invoice-benefit.calculator';

/**
 * S08-DEV-04 / S08-AGG-ROUND/1. Pure, pre-provider planning only.
 * Inputs are server-validated evidence snapshots, NOT proof that IDs were persisted,
 * that invoice eligibility is authenticated, or that a provider operation is authorized.
 * No DB, Stripe, clock, random source, balance movement or state-machine transition.
 */
export const AGGREGATE_ALLOCATION_POLICY = 'S08-AGG-ROUND/1' as const;
type EligibleBenefit = Extract<InvoiceBenefitResult, { eligible: true }>;

export interface AllocationReservation {
  readonly id: string;
  readonly businessId: string;
  /** Original persisted reservation intent; distinct from the Stripe invoice ID. */
  readonly invoiceIntentRef: string;
  /** Server-validated binding to the invoice/currency, not new reservation columns. */
  readonly invoiceRef: string;
  readonly currency: string;
  readonly units: 1;
  readonly state: 'reserved';
  readonly providerAttemptStarted: false;
}

export interface AggregateAllocationInput {
  readonly allocationPolicyVersion: string;
  readonly invoice: Readonly<{ businessId: string; invoiceRef: string; currency: string }>;
  /** Existing calculator result; allocation does not invent a new eligibility gate. */
  readonly benefit: Readonly<EligibleBenefit>;
  /** Validated eligible capacity for this batch, including its reserved units.
   * This is NOT accounts.available after reservation has already deducted those units. */
  readonly eligibleCreditBalance: number;
  readonly reservations: readonly AllocationReservation[];
}

export interface ReservationBenefitAllocation {
  readonly reservationId: string;
  readonly invoiceIntentRef: string;
  readonly units: 1;
  readonly benefitMinor: number;
  readonly providerIdempotencyKey: string;
}

export interface FrozenAggregateBenefitAllocation {
  readonly artifactVersion: 1;
  readonly allocationPolicyVersion: typeof AGGREGATE_ALLOCATION_POLICY;
  readonly benefitPolicyVersion: string;
  readonly businessId: string;
  readonly invoiceRef: string;
  readonly currency: string;
  readonly eligibleBaseMinor: number;
  readonly eligibleCreditBalance: number;
  readonly unitsToApply: number;
  readonly aggregateBenefitMinor: number;
  readonly percentApplied: number;
  readonly allocations: readonly ReservationBenefitAllocation[];
  /** SHA-256 of the versioned canonical tuple described in the block documentation.
   * Integrity/correlation only; not a signature, authorization or durable DB freeze. */
  readonly allocationDigest: string;
  readonly providerVerified: false;
  readonly consumptionAuthorized: false;
}

export type AllocationRejectCode =
  | 'INVALID_INPUT' | 'UNSUPPORTED_POLICY' | 'INVALID_IDENTITY' | 'DUPLICATE_RESERVATION'
  | 'DUPLICATE_INVOICE_INTENT' | 'CROSS_BUSINESS' | 'INVOICE_MISMATCH' | 'CURRENCY_MISMATCH'
  | 'RESERVATION_NOT_ELIGIBLE' | 'PROVIDER_ATTEMPT_STARTED' | 'CREDIT_LIMIT'
  | 'INSUFFICIENT_ELIGIBLE_CREDITS' | 'AGGREGATE_MISMATCH' | 'ZERO_ALLOCATION';

export class AggregateAllocationError extends Error {
  readonly providerVerified = false;
  readonly consumptionAuthorized = false;
  constructor(readonly code: AllocationRejectCode) {
    super(`Aggregate benefit allocation: ${code}`);
    this.name = 'AggregateAllocationError';
  }
}

const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const minor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const uuid = (x: unknown): x is string => typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x) &&
  x !== '00000000-0000-0000-0000-000000000000';
const reference = (x: unknown): x is string => typeof x === 'string' && /^\S{1,255}$/u.test(x);
const currency = (x: unknown): x is string => typeof x === 'string' && /^[a-z]{3}$/.test(x);
const reject = (code: AllocationRejectCode): never => { throw new AggregateAllocationError(code); };

/** Snapshot and deep-freeze before the only async step (local SHA-256).
 * No references to caller-owned objects are retained across that step. */
export async function freezeAggregateBenefitAllocation(input: AggregateAllocationInput): Promise<FrozenAggregateBenefitAllocation> {
  if (!object(input) || !object(input.invoice) || !object(input.benefit) || !Array.isArray(input.reservations))
    reject('INVALID_INPUT');
  const { invoice, benefit } = input;
  const policy = INVOICE_BENEFIT_POLICY_V1;
  if (input.allocationPolicyVersion !== AGGREGATE_ALLOCATION_POLICY || benefit.policyVersion !== policy.version ||
      policy.percentPerCredit !== 1 || policy.maxPercent !== 10 || policy.rounding !== 'floor')
    reject('UNSUPPORTED_POLICY');
  if (!uuid(invoice.businessId) || !reference(invoice.invoiceRef) || !invoice.invoiceRef.startsWith('in_') || invoice.invoiceRef.length <= 3)
    reject('INVALID_IDENTITY');
  if (!currency(invoice.currency) || !currency(benefit.currency)) reject('INVALID_INPUT');
  if (invoice.currency !== benefit.currency) reject('CURRENCY_MISMATCH');
  if (benefit.eligible !== true || benefit.providerVerified !== false || benefit.consumptionAuthorized !== false ||
      !minor(benefit.eligibleBaseMinor) || !minor(benefit.benefitMinor) || !minor(benefit.unitsToApply) ||
      !minor(benefit.unitsNotApplied) || !minor(benefit.percentApplied) || !minor(input.eligibleCreditBalance))
    reject('INVALID_INPUT');

  const count = input.reservations.length;
  if (count < 1 || count > 10) reject('CREDIT_LIMIT');
  if (count > input.eligibleCreditBalance) reject('INSUFFICIENT_ELIGIBLE_CREDITS');
  if (benefit.unitsToApply !== count || benefit.percentApplied !== count * policy.percentPerCredit)
    reject('AGGREGATE_MISMATCH');

  const ids = new Set<string>();
  const intents = new Set<string>();
  const snapshots: { id: string; invoiceIntentRef: string }[] = [];
  for (const reservation of input.reservations) {
    if (!object(reservation) || !uuid(reservation.id) || !uuid(reservation.businessId) ||
        !reference(reservation.invoiceIntentRef) || !reference(reservation.invoiceRef) || !currency(reservation.currency))
      reject('INVALID_IDENTITY');
    if (ids.has(reservation.id)) reject('DUPLICATE_RESERVATION');
    if (intents.has(reservation.invoiceIntentRef)) reject('DUPLICATE_INVOICE_INTENT');
    ids.add(reservation.id);
    intents.add(reservation.invoiceIntentRef);
    if (reservation.businessId !== invoice.businessId) reject('CROSS_BUSINESS');
    if (reservation.invoiceRef !== invoice.invoiceRef) reject('INVOICE_MISMATCH');
    if (reservation.currency !== invoice.currency) reject('CURRENCY_MISMATCH');
    if (reservation.units !== 1 || reservation.state !== 'reserved') reject('RESERVATION_NOT_ELIGIBLE');
    if (reservation.providerAttemptStarted !== false) reject('PROVIDER_ATTEMPT_STARTED');
    snapshots.push({ id: reservation.id, invoiceIntentRef: reservation.invoiceIntentRef });
  }
  // Canonical lowercase UUIDs sort by code unit exactly as their hexadecimal bytes.
  // No locale collation, caller order, timestamps or database response order.
  snapshots.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const base = BigInt(benefit.eligibleBaseMinor);
  const units = BigInt(count);
  const aggregate = BigInt(benefit.benefitMinor);
  // Validate the existing calculator result, rather than substituting a new total.
  const expected = (base * units * BigInt(policy.percentPerCredit)) / 100n;
  if (aggregate !== expected || aggregate * 100n > base * BigInt(policy.maxPercent))
    reject('AGGREGATE_MISMATCH');
  const share = aggregate / units;
  const remainder = aggregate % units;
  if (share === 0n) reject('ZERO_ALLOCATION'); // reject the WHOLE batch; never drop a credit and recalculate

  const allocations = Object.freeze(snapshots.map((r, i): ReservationBenefitAllocation => Object.freeze({
    reservationId: r.id,
    invoiceIntentRef: r.invoiceIntentRef,
    units: 1 as const,
    benefitMinor: Number(share + (BigInt(i) < remainder ? 1n : 0n)),
    providerIdempotencyKey: `benefit-apply:v1:${r.id}`,
  })));
  // Inputs and all intermediate currency arithmetic are integer-safe; no Number
  // multiplication is used for money. Each share is positive and <= the safe total.
  const sum = allocations.reduce((n, a) => n + BigInt(a.benefitMinor), 0n);
  if (sum !== aggregate || allocations.some(a => !Number.isSafeInteger(a.benefitMinor) || a.benefitMinor <= 0))
    reject('AGGREGATE_MISMATCH');

  const body = Object.freeze({
    artifactVersion: 1 as const,
    allocationPolicyVersion: AGGREGATE_ALLOCATION_POLICY,
    benefitPolicyVersion: benefit.policyVersion,
    businessId: invoice.businessId,
    invoiceRef: invoice.invoiceRef,
    currency: invoice.currency,
    eligibleBaseMinor: benefit.eligibleBaseMinor,
    eligibleCreditBalance: input.eligibleCreditBalance,
    unitsToApply: count,
    aggregateBenefitMinor: benefit.benefitMinor,
    percentApplied: benefit.percentApplied,
    allocations,
    providerVerified: false as const,
    consumptionAuthorized: false as const,
  });
  // Fixed field positions and explicit domain/version; no delimiter concatenation.
  const canonical = JSON.stringify([
    'ECHO-GRID:S08-AGG-ROUND:artifact/1', body.allocationPolicyVersion, body.benefitPolicyVersion,
    body.businessId, body.invoiceRef, body.currency, body.eligibleBaseMinor, body.eligibleCreditBalance,
    body.unitsToApply, body.aggregateBenefitMinor, body.percentApplied, false, false,
    allocations.map(a => [a.reservationId, a.invoiceIntentRef, a.units, a.benefitMinor, a.providerIdempotencyKey]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const allocationDigest = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ ...body, allocationDigest });
}
