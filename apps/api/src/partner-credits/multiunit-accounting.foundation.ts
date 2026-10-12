import {
  PROPOSED_PROGRESSIVE_EARNING_RATES,
  PROPOSED_MONTHLY_UNIT_CAP,
  PROPOSED_POLICY_VERSION,
  type ProposedEarningPlan,
} from './progressive-partner-economics.review';

/**
 * REVIEW-ONLY accounting model. Zero database writes or economic authorization.
 * Immutable issuance and terminal allocations must reconcile exactly.
 */
export type UnitBuckets = Readonly<{
  provisional: number;
  available: number;
  reserved: number;
  consumed: number;
  expired: number;
  reversed: number;
  recoveryOffset: number;
}>;
export type LotConservation = Readonly<{
  issuedUnits: number;
  buckets: UnitBuckets;
}>;
const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;
const sumSafe = (a: number, b: number): number => {
  if (!valid(a) || !valid(b) || a > Number.MAX_SAFE_INTEGER - b)
    throw new Error('PARTNER_MULTIUNIT_INVALID_UNITS');
  return a + b;
};

export function assertMultiUnitLotConservation(lot: LotConservation): void {
  if (!valid(lot.issuedUnits)) throw new Error('PARTNER_MULTIUNIT_INVALID_ISSUED');
  const values = Object.values(lot.buckets);
  if (values.length !== 7 || values.some(x => !valid(x)))
    throw new Error('PARTNER_MULTIUNIT_INVALID_BUCKET');
  const allocated = values.reduce(sumSafe, 0);
  if (allocated !== lot.issuedUnits)
    throw new Error('PARTNER_MULTIUNIT_CONSERVATION_FAILURE');
}

/** Immutable transition plan. Must not directly mutate a balance or a lot. */
export function planMultiUnitMovement(input: {
  lot: LotConservation;
  from: keyof UnitBuckets;
  to: keyof UnitBuckets;
  units: number;
}): LotConservation {
  assertMultiUnitLotConservation(input.lot);
  const {from,to,units} = input;
  if (from === to || !valid(units) || units === 0 ||
      input.lot.buckets[from] < units ||
      input.lot.buckets[to] > Number.MAX_SAFE_INTEGER - units)
    throw new Error('PARTNER_MULTIUNIT_MOVEMENT_INVALID');
  const next: LotConservation = {
    issuedUnits: input.lot.issuedUnits,
    buckets: {
      ...input.lot.buckets,
      [from]: input.lot.buckets[from] - units,
      [to]: input.lot.buckets[to] + units,
    },
  };
  assertMultiUnitLotConservation(next);
  return next;
}

/** Whole-award rule for a SINGLE business across ALL its branches (UTC month). */
export function planProgressiveWholeAward(input: {
  plan: ProposedEarningPlan | 'free' | 'enterprise';
  alreadyAwardedUnitsInUtcMonth: number;
}): {
  policyVersion: typeof PROPOSED_POLICY_VERSION;
  candidateUnits: number;
  grantUnits: number;
  state: 'candidate' | 'ineligible' | 'cap_exceeded';
  issuanceAuthorized: false;
} {
  const used = input.alreadyAwardedUnitsInUtcMonth;
  if (!valid(used) || used > PROPOSED_MONTHLY_UNIT_CAP)
    throw new Error('PARTNER_MULTIUNIT_MONTHLY_CAP_INVALID');
  const rate = Object.prototype.hasOwnProperty.call(PROPOSED_PROGRESSIVE_EARNING_RATES,input.plan)
    ? PROPOSED_PROGRESSIVE_EARNING_RATES[input.plan as ProposedEarningPlan] : 0;
  const grantUnits = rate > 0 && used + rate <= PROPOSED_MONTHLY_UNIT_CAP ? rate : 0;
  return {
    policyVersion: PROPOSED_POLICY_VERSION,
    candidateUnits: rate,
    grantUnits,
    state: rate === 0 ? 'ineligible' : grantUnits === 0 ? 'cap_exceeded' : 'candidate',
    issuanceAuthorized: false,
  };
}
