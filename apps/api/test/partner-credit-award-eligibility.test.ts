import { describe, expect, it } from 'vitest';
import { partnerEarningMonthUtc, provisionalAwardEligibility } from '../../src/partner-credits/partner-credit-award-eligibility';

describe('Split 07 UTC award-preparation rules', () => {
  it('uses UTC month rather than receiving branch local timezone', () => {
    expect(partnerEarningMonthUtc(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(partnerEarningMonthUtc(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
  });
  it('rejects historic settlements and exhausted monthly awards', () => {
    const fulfilledAt=new Date('2026-10-10T10:00:00.000Z');
    const base={fulfilledAt, enrolledEffectiveAt:new Date('2026-10-10T09:00:00.000Z'),
      policyEffectiveAt:new Date('2026-10-01T00:00:00.000Z'),awardedUnitsInUtcMonth:9};
    expect(provisionalAwardEligibility(base)).toBe('eligible');
    expect(provisionalAwardEligibility({...base,enrolledEffectiveAt:new Date('2026-10-11T00:00:00.000Z')})).toBe('pre_enrollment');
    expect(provisionalAwardEligibility({...base,awardedUnitsInUtcMonth:10})).toBe('cap_exceeded');
    expect(provisionalAwardEligibility({...base,policyEffectiveAt:new Date('2026-10-11T00:00:00.000Z')})).toBe('policy_not_effective');
  });
});
