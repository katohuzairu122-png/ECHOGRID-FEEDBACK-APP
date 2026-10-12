import { assertMultiUnitLotConservation, planMultiUnitMovement, type LotConservation, type UnitBuckets } from './multiunit-accounting.foundation';

/** Non-activating transition proof. SQL write guards from 0041/0042/0044 remain authoritative. */
export type MultiunitMovementIntent = Readonly<{
  allocationId: string;
  idempotencyKey: string;
  from: keyof UnitBuckets;
  to: keyof UnitBuckets;
  units: number;
}>;
export type MovementProof = Readonly<{
  before: LotConservation;
  after: LotConservation;
  intent: MultiunitMovementIntent;
  issuanceAuthorized: false;
  executionAuthorized: false;
}>;
const allowed: Readonly<Record<keyof UnitBuckets, readonly (keyof UnitBuckets)[]>> = {
  provisional: ['available','reversed'],
  available: ['reserved','expired','reversed','recoveryOffset'],
  reserved: ['available','consumed','reversed'],
  consumed: [],
  expired: [],
  reversed: [],
  recoveryOffset: [],
};
/** Rejects impossible lifecycle transitions; never mutates a database row. */
export function validateMultiunitMovement(input: {
  lot: LotConservation;
  intent: MultiunitMovementIntent;
}): MovementProof {
  const {lot,intent} = input;
  assertMultiUnitLotConservation(lot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.allocationId) ||
      !intent.idempotencyKey.trim() || intent.idempotencyKey.length > 256 ||
      !Object.prototype.hasOwnProperty.call(allowed,intent.from) ||
      !Object.prototype.hasOwnProperty.call(allowed,intent.to) ||
      !allowed[intent.from].includes(intent.to))
    throw new Error('PARTNER_MULTIUNIT_TRANSITION_FORBIDDEN');
  const after = planMultiUnitMovement({lot,from:intent.from,to:intent.to,units:intent.units});
  return {before:lot,after,intent,issuanceAuthorized:false,executionAuthorized:false};
}
