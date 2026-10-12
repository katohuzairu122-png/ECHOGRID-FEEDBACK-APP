import { describe, expect, it } from 'vitest';
import {
  assertMultiUnitLotConservation,
  planMultiUnitMovement,
  planProgressiveWholeAward,
  type LotConservation,
} from '../src/partner-credits/multiunit-accounting.foundation';

const lot: LotConservation = {
  issuedUnits: 3,
  buckets: {
    provisional: 3, available: 0, reserved: 0, consumed: 0,
    expired: 0, reversed: 0, recoveryOffset: 0,
  },
};
describe('Split 07 non-activating multi-unit accounting', () => {
  it('conserves every issued unit across vesting, reservation and consumption', () => {
    let next = planMultiUnitMovement({lot,from:'provisional',to:'available',units:3});
    next = planMultiUnitMovement({lot:next,from:'available',to:'reserved',units:2});
    next = planMultiUnitMovement({lot:next,from:'reserved',to:'consumed',units:1});
    expect(next.buckets).toMatchObject({available:1,reserved:1,consumed:1,provisional:0});
    expect(() => assertMultiUnitLotConservation(next)).not.toThrow();
  });
  it('rejects missing, duplicate or negative accounting units', () => {
    expect(() => assertMultiUnitLotConservation({...lot,issuedUnits:4}))
      .toThrow('PARTNER_MULTIUNIT_CONSERVATION_FAILURE');
    expect(() => assertMultiUnitLotConservation({...lot,buckets:{...lot.buckets,available:-1}}))
      .toThrow('PARTNER_MULTIUNIT_INVALID_BUCKET');
    expect(() => planMultiUnitMovement({lot,from:'available',to:'consumed',units:1}))
      .toThrow('PARTNER_MULTIUNIT_MOVEMENT_INVALID');
    expect(() => planMultiUnitMovement({lot,from:'provisional',to:'provisional',units:1}))
      .toThrow('PARTNER_MULTIUNIT_MOVEMENT_INVALID');
  });
  it('rejects unsafe or fractional quantities', () => {
    expect(() => planMultiUnitMovement({lot,from:'provisional',to:'available',units:1.5}))
      .toThrow('PARTNER_MULTIUNIT_MOVEMENT_INVALID');
    expect(() => planMultiUnitMovement({lot,from:'provisional',to:'available',units:Number.MAX_SAFE_INTEGER}))
      .toThrow('PARTNER_MULTIUNIT_MOVEMENT_INVALID');
  });
  it('uses 3/2/1 whole units, not settlement counts, at the ten-unit boundary', () => {
    expect(planProgressiveWholeAward({plan:'starter',alreadyAwardedUnitsInUtcMonth:7}))
      .toMatchObject({candidateUnits:3,grantUnits:3,state:'candidate',issuanceAuthorized:false});
    expect(planProgressiveWholeAward({plan:'starter',alreadyAwardedUnitsInUtcMonth:8}))
      .toMatchObject({candidateUnits:3,grantUnits:0,state:'cap_exceeded'});
    expect(planProgressiveWholeAward({plan:'growth',alreadyAwardedUnitsInUtcMonth:8}))
      .toMatchObject({candidateUnits:2,grantUnits:2,state:'candidate'});
    expect(planProgressiveWholeAward({plan:'growth',alreadyAwardedUnitsInUtcMonth:9}))
      .toMatchObject({candidateUnits:2,grantUnits:0,state:'cap_exceeded'});
    expect(planProgressiveWholeAward({plan:'business',alreadyAwardedUnitsInUtcMonth:9}))
      .toMatchObject({candidateUnits:1,grantUnits:1,state:'candidate'});
  });
  it('excludes free/enterprise and invalid monthly totals', () => {
    for (const plan of ['free','enterprise'] as const)
      expect(planProgressiveWholeAward({plan,alreadyAwardedUnitsInUtcMonth:0}))
        .toMatchObject({grantUnits:0,state:'ineligible',issuanceAuthorized:false});
    expect(() => planProgressiveWholeAward({plan:'starter',alreadyAwardedUnitsInUtcMonth:-1}))
      .toThrow('PARTNER_MULTIUNIT_MONTHLY_CAP_INVALID');
    expect(() => planProgressiveWholeAward({plan:'starter',alreadyAwardedUnitsInUtcMonth:11}))
      .toThrow('PARTNER_MULTIUNIT_MONTHLY_CAP_INVALID');
  });
});
