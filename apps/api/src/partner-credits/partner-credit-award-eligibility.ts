/** Deterministic UTC accounting helpers. No DB writes and no issuance. */
export function partnerEarningMonthUtc(fulfilledAt: Date): string {
  if (!Number.isFinite(fulfilledAt.getTime())) throw new Error('INVALID_FULFILLMENT_TIME');
  return fulfilledAt.toISOString().slice(0, 7);
}
export function provisionalAwardEligibility(input: {
  fulfilledAt: Date;
  enrolledEffectiveAt: Date;
  policyEffectiveAt: Date;
  awardedUnitsInUtcMonth: number;
}): 'eligible' | 'pre_enrollment' | 'policy_not_effective' | 'cap_exceeded' {
  if (input.fulfilledAt < input.enrolledEffectiveAt) return 'pre_enrollment';
  if (input.fulfilledAt < input.policyEffectiveAt) return 'policy_not_effective';
  if (!Number.isInteger(input.awardedUnitsInUtcMonth) || input.awardedUnitsInUtcMonth < 0)
    throw new Error('INVALID_AWARDED_MONTH_COUNTER');
  return input.awardedUnitsInUtcMonth >= 10 ? 'cap_exceeded' : 'eligible';
}
