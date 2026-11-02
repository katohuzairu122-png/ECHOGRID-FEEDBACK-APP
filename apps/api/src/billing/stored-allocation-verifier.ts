import {
  freezeAggregateBenefitAllocation,
  type AggregateAllocationInput,
  type FrozenAggregateBenefitAllocation,
} from './aggregate-benefit-allocation';

/**
 * S08-DEV-05: read-side verifier for a persisted allocation snapshot.
 * A digest is not provider, identity, invoice-state or financial authority.
 *
 * Persistence adapters must independently validate DB reservation ownership,
 * draft invoice status and pre-attempt locks in a transaction. This module
 * only verifies the exact evidence that was stored and re-materialized.
 */
export type AllocationVerification =
  | {
      readonly status: 'verified_snapshot';
      readonly artifact: FrozenAggregateBenefitAllocation;
      readonly providerVerified: false;
      readonly consumptionAuthorized: false;
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'invalid_snapshot' | 'content_mismatch' | 'digest_mismatch';
      readonly providerVerified: false;
      readonly consumptionAuthorized: false;
    };

export async function verifyStoredAllocationSnapshot(
  stored: unknown,
  authoritativeInput: AggregateAllocationInput,
): Promise<AllocationVerification> {
  const failed = (
    reason: 'invalid_snapshot' | 'content_mismatch' | 'digest_mismatch',
  ): AllocationVerification => ({
    status: 'rejected',
    reason,
    providerVerified: false,
    consumptionAuthorized: false,
  });

  if (typeof stored !== 'object' || stored === null || Array.isArray(stored))
    return failed('invalid_snapshot');
  const record = stored as Record<string, unknown>;
  if (
    record.providerVerified !== false ||
    record.consumptionAuthorized !== false ||
    record.artifactVersion !== 1 ||
    typeof record.allocationDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.allocationDigest) ||
    !Array.isArray(record.allocations)
  ) {
    return failed('invalid_snapshot');
  }

  let expected: FrozenAggregateBenefitAllocation;
  try {
    expected = await freezeAggregateBenefitAllocation(authoritativeInput);
  } catch {
    return failed('invalid_snapshot');
  }
  // Recompute from independently checked source data; never accept a self-consistent
  // caller-produced digest as authentication of the invoice or reservations.
  if (record.allocationDigest !== expected.allocationDigest) return failed('digest_mismatch');

  const keys = [
    'artifactVersion',
    'allocationPolicyVersion',
    'benefitPolicyVersion',
    'businessId',
    'invoiceRef',
    'currency',
    'eligibleBaseMinor',
    'eligibleCreditBalance',
    'unitsToApply',
    'aggregateBenefitMinor',
    'percentApplied',
    'providerVerified',
    'consumptionAuthorized',
  ] as const;
  for (const key of keys) if (record[key] !== expected[key]) return failed('content_mismatch');

  if (record.allocations.length !== expected.allocations.length) return failed('content_mismatch');
  for (let i = 0; i < expected.allocations.length; i++) {
    const actual = record.allocations[i];
    const known = expected.allocations[i];
    if (!known || typeof actual !== 'object' || actual === null || Array.isArray(actual))
      return failed('content_mismatch');
    const candidate = actual as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 5 ||
      candidate.reservationId !== known.reservationId ||
      candidate.invoiceIntentRef !== known.invoiceIntentRef ||
      candidate.units !== known.units ||
      candidate.benefitMinor !== known.benefitMinor ||
      candidate.providerIdempotencyKey !== known.providerIdempotencyKey
    )
      return failed('content_mismatch');
  }
  if (Object.keys(record).length !== keys.length + 2) return failed('content_mismatch');
  return {
    status: 'verified_snapshot',
    artifact: expected,
    providerVerified: false,
    consumptionAuthorized: false,
  };
}

/** Relational envelope as well as JSON must agree. This is integrity only,
 * never authenticated provider evidence or permission to move credits. */
export interface StoredAllocationParent {
  id: string;
  business_id: string;
  invoice_ref: string;
  currency: string;
  policy_version: string;
  allocation_digest: string;
  aggregate_benefit_minor: string;
  reservation_count: number;
  provider_verified: boolean;
  consumption_authorized: boolean;
  artifact: unknown;
}

export interface StoredAllocationItem {
  freeze_id: string;
  business_id: string;
  reservation_id: string;
  invoice_intent_ref: string;
  benefit_minor: string;
  provider_idempotency_key: string;
}

export async function verifyStoredAllocationEvidence(
  parent: StoredAllocationParent,
  items: readonly StoredAllocationItem[],
  source?: AggregateAllocationInput,
): Promise<AllocationVerification> {
  const rejected: AllocationVerification = {
    status: 'rejected',
    reason: 'content_mismatch',
    providerVerified: false,
    consumptionAuthorized: false,
  };
  try {
    // With no independent source, reconstruct ONLY to check internal integrity.
    // Neither a coherent persisted envelope nor this reconstruction is authority.
    const a = parent.artifact as FrozenAggregateBenefitAllocation;
    const input =
      source ??
      ({
        allocationPolicyVersion: a.allocationPolicyVersion,
        invoice: { businessId: a.businessId, invoiceRef: a.invoiceRef, currency: a.currency },
        benefit: {
          eligible: true,
          policyVersion: a.benefitPolicyVersion,
          unitsToApply: a.unitsToApply,
          unitsNotApplied: 0,
          eligibleBaseMinor: a.eligibleBaseMinor,
          benefitMinor: a.aggregateBenefitMinor,
          percentApplied: a.percentApplied,
          currency: a.currency,
          providerVerified: false,
          consumptionAuthorized: false,
        },
        eligibleCreditBalance: a.eligibleCreditBalance,
        reservations: a.allocations.map((item) => ({
          id: item.reservationId,
          businessId: a.businessId,
          invoiceIntentRef: item.invoiceIntentRef,
          invoiceRef: a.invoiceRef,
          currency: a.currency,
          units: item.units,
          state: 'reserved',
          providerAttemptStarted: false,
        })),
      } satisfies AggregateAllocationInput);
    const result = await verifyStoredAllocationSnapshot(parent.artifact, input);
    if (result.status !== 'verified_snapshot') return result;
    const expected = result.artifact;
    if (
      parent.business_id !== expected.businessId ||
      parent.invoice_ref !== expected.invoiceRef ||
      parent.currency !== expected.currency ||
      parent.policy_version !== expected.allocationPolicyVersion ||
      parent.allocation_digest !== expected.allocationDigest ||
      BigInt(parent.aggregate_benefit_minor) !== BigInt(expected.aggregateBenefitMinor) ||
      parent.reservation_count !== expected.allocations.length ||
      parent.provider_verified !== false ||
      parent.consumption_authorized !== false ||
      items.length !== expected.allocations.length
    )
      return rejected;
    for (const [i, item] of items.entries()) {
      const allocation = expected.allocations[i];
      if (
        !allocation ||
        item.freeze_id !== parent.id ||
        item.business_id !== expected.businessId ||
        item.reservation_id !== allocation.reservationId ||
        item.invoice_intent_ref !== allocation.invoiceIntentRef ||
        BigInt(item.benefit_minor) !== BigInt(allocation.benefitMinor) ||
        item.provider_idempotency_key !== allocation.providerIdempotencyKey
      )
        return rejected;
    }
    return result;
  } catch {
    return rejected;
  }
}
