import { describe, it, expect } from 'vitest';
import { toCents, wouldExceedBudget } from './budget-limit';

/**
 * WHY THESE ARE UNIT TESTS AND NOT MORE INTEGRATION TESTS (audit P0-5)
 * The existing integration suite already covers maxBudget end to end
 * against real Postgres -- and passes, because it uses `rewardValue:
 * '10.00'` with `maxBudget: '20.00'`. Both are exactly representable in
 * binary floating point, so the defect is invisible to it. Every case in
 * this file that matters is a value pair that is NOT exactly
 * representable, and enumerating those costs one real database round trip
 * each in that tier (those 46 tests take 172 seconds). Here the whole
 * table runs in milliseconds.
 *
 * That is the shape of the P0-5 gap generally: not "these services have no
 * tests" but "their decision arithmetic has never been walked to its
 * boundaries, because the tier that covers them is too slow to walk it".
 */
describe('toCents', () => {
  it('converts the numeric(10,2) values that break float multiplication', () => {
    expect(toCents('8.30')).toBe(830);
    expect(toCents('0.10')).toBe(10);
    expect(toCents('1.10')).toBe(110);
    expect(toCents('0.07')).toBe(7);
    expect(toCents('9.10')).toBe(910);
    expect(toCents('99.60')).toBe(9960);
  });

  it('handles whole numbers, zero-ish values and the column maximum', () => {
    expect(toCents('0.01')).toBe(1);
    expect(toCents('5')).toBe(500);
    expect(toCents('20.00')).toBe(2000);
    expect(toCents('99999999.99')).toBe(9999999999);
    // Still inside Number.MAX_SAFE_INTEGER, so the multiplication in
    // wouldExceedBudget cannot lose precision at the column's ceiling.
    expect(9999999999).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('accepts a number as well as a string', () => {
    // Drizzle hands numeric over as a string, but the service layer's own
    // create path (loyalty-reward.service.ts) takes numbers.
    expect(toCents(8.3)).toBe(830);
    expect(toCents(0.07)).toBe(7);
  });
});

describe('wouldExceedBudget', () => {
  /**
   * The five measured disagreements between the old float expression and
   * exact decimal arithmetic. Each row is [alreadyIssued, rewardValue,
   * maxBudget, shouldExceed] where shouldExceed is the EXACT answer.
   *
   * Against the pre-fix code, the first four of these fail.
   */
  const FLOAT_TRAP_CASES: Array<[number, string, string, boolean]> = [
    // 3 x 0.10 = 0.30000000000000004 -> old code rejected a claim that fits
    [2, '0.10', '0.30', false],
    // 3 x 1.10 = 3.3000000000000003 -> same
    [2, '1.10', '3.30', false],
    // 12 x 8.30 = 99.60000000000001 -> same, at a realistic campaign size
    [11, '8.30', '99.60', false],
    // 3 x 0.07 = 0.21000000000000002 -> same, smallest realistic values
    [2, '0.07', '0.21', false],
    // 7 x 0.70 = 4.8999999999999995 -> old code allowed it; exactly fits
    [6, '0.70', '4.90', false],
  ];

  it.each(FLOAT_TRAP_CASES)(
    'issued=%i value=%s budget=%s -> exceeds=%s (float arithmetic got this wrong)',
    (alreadyIssued, rewardValue, maxBudget, shouldExceed) => {
      expect(wouldExceedBudget({ alreadyIssued, rewardValue, maxBudget })).toBe(shouldExceed);
    },
  );

  it('allows spending the budget EXACTLY, to the last cent', () => {
    // The boundary the float version could not hold. 12 x 8.30 is precisely
    // 99.60, and a business that configured a 99.60 budget is entitled to
    // all of it.
    expect(wouldExceedBudget({ alreadyIssued: 11, rewardValue: '8.30', maxBudget: '99.60' })).toBe(false);
    expect(wouldExceedBudget({ alreadyIssued: 1, rewardValue: '10.00', maxBudget: '20.00' })).toBe(false);
    expect(wouldExceedBudget({ alreadyIssued: 9, rewardValue: '0.29', maxBudget: '2.90' })).toBe(false);
  });

  it('rejects the very next claim once the budget is exactly spent', () => {
    expect(wouldExceedBudget({ alreadyIssued: 12, rewardValue: '8.30', maxBudget: '99.60' })).toBe(true);
    expect(wouldExceedBudget({ alreadyIssued: 2, rewardValue: '10.00', maxBudget: '20.00' })).toBe(true);
  });

  it('rejects an overspend of a single cent', () => {
    // 3 x 0.10 = 0.30 fits a 0.30 budget but not a 0.29 one. One cent is
    // the smallest difference these columns can express, so this is the
    // tightest possible statement that the guard is exact.
    expect(wouldExceedBudget({ alreadyIssued: 2, rewardValue: '0.10', maxBudget: '0.29' })).toBe(true);
    expect(wouldExceedBudget({ alreadyIssued: 2, rewardValue: '0.10', maxBudget: '0.30' })).toBe(false);
  });

  it('reproduces the round-number cases the integration suite already covers', () => {
    // Regression guard in the other direction: the existing end-to-end
    // behaviour these tests must not change. rewardValue '10.00' /
    // maxBudget '20.00' is exactly what
    // "issue allows redemptions up to maxBudget and rejects the one that
    // would exceed it" sets up.
    expect(wouldExceedBudget({ alreadyIssued: 0, rewardValue: '10.00', maxBudget: '20.00' })).toBe(false);
    expect(wouldExceedBudget({ alreadyIssued: 1, rewardValue: '10.00', maxBudget: '20.00' })).toBe(false);
    expect(wouldExceedBudget({ alreadyIssued: 2, rewardValue: '10.00', maxBudget: '20.00' })).toBe(true);
  });

  it('rejects the FIRST claim when one redemption alone busts the budget', () => {
    // maxBudget smaller than rewardValue is a misconfiguration, but it must
    // fail closed rather than let one through.
    expect(wouldExceedBudget({ alreadyIssued: 0, rewardValue: '10.00', maxBudget: '0.01' })).toBe(true);
    expect(wouldExceedBudget({ alreadyIssued: 0, rewardValue: '0.02', maxBudget: '0.01' })).toBe(true);
  });

  it('treats a null maxBudget as no budget at all', () => {
    expect(wouldExceedBudget({ alreadyIssued: 9999, rewardValue: '10.00', maxBudget: null })).toBe(false);
  });

  it('treats a null rewardValue as unbudgetable, even with a budget set', () => {
    // A 'points'-type reward has a null rewardValue, so maxBudget is a
    // deliberate no-op for it -- a product decision, asserted by the
    // integration suite's "redeem does not enforce maxBudget for a
    // points-type reward, even when maxBudget is set" (which sets
    // maxBudget: '0.01' precisely so it WOULD reject if this were wrong).
    // Preserved here so this fix cannot quietly change it.
    expect(wouldExceedBudget({ alreadyIssued: 0, rewardValue: null, maxBudget: '0.01' })).toBe(false);
    expect(wouldExceedBudget({ alreadyIssued: 9999, rewardValue: null, maxBudget: '0.01' })).toBe(false);
  });

  it('stays exact across a long campaign, not just the first few claims', () => {
    // Drift is the failure mode repeated float multiplication is famous
    // for. Walk every claim of a 0.07-value reward against a 7.00 budget:
    // exactly 100 should fit and the 101st must not.
    const fits: number[] = [];
    for (let issued = 0; issued < 120; issued++) {
      if (!wouldExceedBudget({ alreadyIssued: issued, rewardValue: '0.07', maxBudget: '7.00' })) {
        fits.push(issued);
      }
    }
    expect(fits).toHaveLength(100);
    expect(fits[0]).toBe(0);
    expect(fits[99]).toBe(99);
  });
});
