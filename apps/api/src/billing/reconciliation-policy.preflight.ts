/**
 * Group 17 DEV-95–97: pure, fail-closed configuration boundary for the
 * inert read-only provider-reconciliation scheduler.
 *
 * This validates operator/test controls, not financial authorization.
 * It deliberately keeps the historic two-observation minimum and default
 * 5-minute separation. It cannot certify settlement or allow credit writes.
 */
export type ReconciliationPolicyInput = {
  requiredAbsences?: number;
  minAbsenceGapMs?: number;
  inFlightWindowMs?: number;
};

export type ReconciliationPolicy = {
  requiredAbsences: number;
  minAbsenceGapMs: number;
  inFlightWindowMs: number;
};

const finiteNonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function resolveReconciliationPolicy(input: ReconciliationPolicyInput): ReconciliationPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('RECONCILIATION_POLICY_INVALID');
  }

  const requestedAbsences = input.requiredAbsences === undefined ? 2 : input.requiredAbsences;
  const requestedGap = input.minAbsenceGapMs === undefined ? 300_000 : input.minAbsenceGapMs;
  const requestedWindow = input.inFlightWindowMs === undefined ? 120_000 : input.inFlightWindowMs;
  if (!finiteNonnegativeInteger(requestedAbsences) ||
      !finiteNonnegativeInteger(requestedGap) ||
      !finiteNonnegativeInteger(requestedWindow)) {
    throw new Error('RECONCILIATION_POLICY_INVALID');
  }

  // Existing policy: fewer than two absent-complete observations cannot
  // establish absence. Explicit 0 or 1 is normalized upward, never downward.
  return {
    requiredAbsences: Math.max(requestedAbsences, 2),
    minAbsenceGapMs: requestedGap,
    inFlightWindowMs: requestedWindow,
  };
}
