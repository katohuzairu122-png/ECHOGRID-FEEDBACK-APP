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
  | { readonly status: 'verified_snapshot'; readonly artifact: FrozenAggregateBenefitAllocation; readonly providerVerified: false; readonly consumptionAuthorized: false }
  | { readonly status: 'rejected'; readonly reason: 'invalid_snapshot' | 'content_mismatch' | 'digest_mismatch'; readonly providerVerified: false; readonly consumptionAuthorized: false };

export async function verifyStoredAllocationSnapshot(
  stored: unknown,
  authoritativeInput: AggregateAllocationInput,
): Promise<AllocationVerification> {
  const failed = (reason: 'invalid_snapshot' | 'content_mismatch' | 'digest_mismatch'): AllocationVerification =>
    ({ status: 'rejected', reason, providerVerified: false, consumptionAuthorized: false });

  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return failed('invalid_snapshot');
  const record = stored as Record<string, unknown>;
  if (record.providerVerified !== false || record.consumptionAuthorized !== false ||
      record.artifactVersion !== 1 || typeof record.allocationDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.allocationDigest) || !Array.isArray(record.allocations)) {
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
    'artifactVersion', 'allocationPolicyVersion', 'benefitPolicyVersion', 'businessId',
    'invoiceRef', 'currency', 'eligibleBaseMinor', 'eligibleCreditBalance',
    'unitsToApply', 'aggregateBenefitMinor', 'percentApplied',
    'providerVerified', 'consumptionAuthorized',
  ] as const;
  for (const key of keys) if (record[key] !== expected[key]) return failed('content_mismatch');

  if (record.allocations.length !== expected.allocations.length) return failed('content_mismatch');
  for (let i = 0; i < expected.allocations.length; i++) {
    const actual = record.allocations[i];
    const known = expected.allocations[i];
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return failed('content_mismatch');
    const candidate = actual as Record<string, unknown>;
    if (Object.keys(candidate).length !== 5 ||
        candidate.reservationId !== known.reservationId ||
        candidate.invoiceIntentRef !== known.invoiceIntentRef ||
        candidate.units !== known.units ||
        candidate.benefitMinor !== known.benefitMinor ||
        candidate.providerIdempotencyKey !== known.providerIdempotencyKey) return failed('content_mismatch');
  }
  if (Object.keys(record).length !== keys.length + 2) return failed('content_mismatch');
  return { status: 'verified_snapshot', artifact: expected, providerVerified: false, consumptionAuthorized: false };
}
