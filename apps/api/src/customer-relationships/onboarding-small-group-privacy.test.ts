import { describe, expect, it } from 'vitest';
import type { OnboardingSummary } from '../repositories/customer-onboarding-event.repository';
import { applySmallGroupSuppression } from './onboarding-small-group-privacy';

const cell = (events: number, uniq = events) => ({ events, uniqueCustomers: uniq });
const summary = (over: Partial<OnboardingSummary> = {}): OnboardingSummary => ({
  totals: { events: 20, uniqueCustomers: 18, rejoinEvents: 2, withoutBranch: 0, erasedEvents: 1 },
  bySource: [{ source: 'business_qr', ...cell(17, 15) }, { source: 'cashier_assisted', ...cell(3, 3) }],
  byBranch: [{ branchId: 'b1', branchName: 'One', ...cell(12, 11) }, { branchId: 'b2', branchName: 'Two', ...cell(6, 6) }, { branchId: 'b3', branchName: 'Three', ...cell(2, 2) }],
  byCashier: [{ cashierUserId: 'c1', displayName: 'Ann', ...cell(3, 3) }],
  ...over,
});

describe('D2-FINAL small-group suppression (the threshold is a parameter, never decided here)', () => {
  it('refuses a missing, tiny or non-integer threshold: no silent default is invented', () => {
    for (const k of [0, 1, -3, 2.5, Number.NaN]) expect(() => applySmallGroupSuppression(summary(), { minGroupSize: k })).toThrow('SMALL_GROUP_THRESHOLD_INVALID');
  });

  it('shows cells at or above the threshold and folds smaller ones into one suppressed bucket', () => {
    const out = applySmallGroupSuppression(summary(), { minGroupSize: 5 });
    expect(out.byBranch.filter((c) => !c.suppressed).map((c) => c.events)).toEqual([12]);
    // the 2-event branch is below 5; the hidden bucket (2) is still unsafe, so the smallest visible cell (6) is folded in too (complementary suppression)
    const hidden = out.byBranch.find((c) => c.suppressed)!;
    expect(hidden).toEqual({ suppressed: true, events: 8, uniqueCustomers: null });
  });

  it('complementary suppression: a single small cell is never recoverable by subtracting the visible cells from the total', () => {
    const out = applySmallGroupSuppression(summary({ byBranch: [{ branchId: 'b1', branchName: 'One', ...cell(18, 17) }, { branchId: 'b2', branchName: 'Two', ...cell(2, 2) }] }), { minGroupSize: 5 });
    const visible = out.byBranch.filter((c) => !c.suppressed);
    // 18 is folded in with the 2 so the hidden bucket (20) is safe and no remaining cell reveals the 2
    expect(visible).toEqual([]);
    expect(out.byBranch).toEqual([{ suppressed: true, events: 20, uniqueCustomers: null }]);
  });

  it('when a whole dimension is below the threshold it reports one suppressed bucket with NO counts', () => {
    const out = applySmallGroupSuppression(summary({ byBranch: [{ branchId: 'b1', branchName: 'One', ...cell(2, 2) }, { branchId: 'b2', branchName: 'Two', ...cell(1, 1) }] }), { minGroupSize: 5 });
    expect(out.byBranch).toEqual([{ suppressed: true, events: null, uniqueCustomers: null }]);
  });

  it('shows unique customers only when they are themselves at or above the threshold', () => {
    const out = applySmallGroupSuppression(summary(), { minGroupSize: 5 });
    const first = out.byBranch.find((c) => !c.suppressed && c.events === 12)!;
    expect(first.uniqueCustomers).toBe(11);
    const second = out.byBranch.find((c) => !c.suppressed && c.events === 6);
    expect(second).toBeUndefined(); // folded by complementary suppression, so its 6 customers are not shown either
    expect(applySmallGroupSuppression(summary({ totals: { events: 20, uniqueCustomers: 3, rejoinEvents: 0, withoutBranch: 0, erasedEvents: 0 } }), { minGroupSize: 5 }).totals.uniqueCustomers).toBeNull();
  });

  it('hides small non-zero side counts but keeps zero, and hides a total that is itself small', () => {
    const out = applySmallGroupSuppression(summary(), { minGroupSize: 5 });
    expect(out.totals).toMatchObject({ events: 20, rejoinEvents: null, withoutBranch: 0, erasedEvents: null });
    expect(applySmallGroupSuppression(summary({ totals: { events: 3, uniqueCustomers: 3, rejoinEvents: 0, withoutBranch: 0, erasedEvents: 0 } }), { minGroupSize: 5 }).totals.events).toBeNull();
  });

  it('can remove the per-cashier breakdown entirely (cashier attribution is an indirect identifier, R3)', () => {
    expect(applySmallGroupSuppression(summary(), { minGroupSize: 5, suppressCashierBreakdown: true }).byCashier).toBeNull();
    const kept = applySmallGroupSuppression(summary(), { minGroupSize: 5 }).byCashier!;
    expect(kept.some((c) => !c.suppressed)).toBe(false); // a lone 3-event cashier is suppressed even when the breakdown is kept
  });

  it('never leaks a customer id, name or exact small count in the output', () => {
    const json = JSON.stringify(applySmallGroupSuppression(summary(), { minGroupSize: 5 }));
    expect(json).not.toMatch(/"events":2[,}]/);
    expect(json).not.toMatch(/"events":3[,}]/);
    expect(json).not.toContain('Three');
  });
});
