import { describe, expect, it } from 'vitest';
import { partnerExpiryAt } from '../src/partner-credits/partner-credit-lifecycle.service';
describe('Split 07 UTC 12-calendar-month expiry', () => {
  it('preserves UTC clock and clamps leap-day anniversary', () => {
    expect(partnerExpiryAt(new Date('2024-02-29T14:09:13.321Z')).toISOString())
      .toBe('2025-02-28T14:09:13.321Z');
    expect(partnerExpiryAt(new Date('2025-01-31T23:59:59.999Z')).toISOString())
      .toBe('2026-01-31T23:59:59.999Z');
  });
  it('rejects invalid vesting instants', () => {
    expect(() => partnerExpiryAt(new Date(NaN))).toThrow('PARTNER_VEST_INVALID_TIME');
  });
});
