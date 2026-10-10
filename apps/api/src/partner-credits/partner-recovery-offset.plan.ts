/**
 * Frozen Split 07 recovery-conservation arithmetic.
 * Pure accounting plan ONLY. An obligation can be created only after verified
 * immutable consumption evidence, which Split 08 does not yet expose.
 * Never debit cash/Stripe or make available units negative.
 */
export function planPartnerRecoveryOffset(input: {
  outstandingUnits: number;
  newlyVestingUnits: number;
}): { offsetUnits: number; vestAvailableUnits: number; remainingDueUnits: number } {
  const { outstandingUnits, newlyVestingUnits } = input;
  if (![outstandingUnits,newlyVestingUnits].every(x=>Number.isSafeInteger(x)&&x>=0))
    throw new Error('PARTNER_RECOVERY_INVALID_UNITS');
  const offsetUnits = Math.min(outstandingUnits,newlyVestingUnits);
  return {
    offsetUnits,
    vestAvailableUnits: newlyVestingUnits-offsetUnits,
    remainingDueUnits: outstandingUnits-offsetUnits,
  };
}
