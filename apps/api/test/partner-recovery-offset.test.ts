import { describe,expect,it } from 'vitest';
import { planPartnerRecoveryOffset } from '../src/partner-credits/partner-recovery-offset.plan';
describe('Split 07 frozen recovery offset accounting',()=>{
  it('uses newly vesting credits before any becomes available',()=>{
    expect(planPartnerRecoveryOffset({outstandingUnits:2,newlyVestingUnits:1}))
      .toEqual({offsetUnits:1,vestAvailableUnits:0,remainingDueUnits:1});
    expect(planPartnerRecoveryOffset({outstandingUnits:1,newlyVestingUnits:3}))
      .toEqual({offsetUnits:1,vestAvailableUnits:2,remainingDueUnits:0});
  });
  it('does not invent negative units or offsets',()=>{
    expect(planPartnerRecoveryOffset({outstandingUnits:0,newlyVestingUnits:1}))
      .toEqual({offsetUnits:0,vestAvailableUnits:1,remainingDueUnits:0});
    expect(()=>planPartnerRecoveryOffset({outstandingUnits:-1,newlyVestingUnits:1})).toThrow();
    expect(()=>planPartnerRecoveryOffset({outstandingUnits:1.5,newlyVestingUnits:1})).toThrow();
  });
});
