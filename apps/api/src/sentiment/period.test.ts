import { describe, it, expect } from 'vitest';
import { computePeriodRange, formatPeriodLabel } from './period';

const FIXED_NOW = new Date('2026-07-09T12:00:00.000Z');

describe('computePeriodRange', () => {
  it('weekly: periodStart is exactly 7 days before periodEnd', () => {
    const { periodStart, periodEnd } = computePeriodRange('weekly', FIXED_NOW);
    expect(periodEnd.toISOString()).toBe(FIXED_NOW.toISOString());
    expect(periodStart.toISOString()).toBe('2026-07-02T12:00:00.000Z');
  });

  it('monthly: periodStart is exactly 1 UTC calendar month before periodEnd', () => {
    const { periodStart, periodEnd } = computePeriodRange('monthly', FIXED_NOW);
    expect(periodEnd.toISOString()).toBe(FIXED_NOW.toISOString());
    expect(periodStart.toISOString()).toBe('2026-06-09T12:00:00.000Z');
  });

  it('defaults `now` to the current time when omitted -- periodEnd is close to Date.now()', () => {
    const before = Date.now();
    const { periodEnd } = computePeriodRange('weekly');
    const after = Date.now();
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(before);
    expect(periodEnd.getTime()).toBeLessThanOrEqual(after);
  });

  it('does not mutate the `now` argument passed in', () => {
    const now = new Date(FIXED_NOW);
    computePeriodRange('monthly', now);
    expect(now.toISOString()).toBe(FIXED_NOW.toISOString());
  });
});

describe('formatPeriodLabel', () => {
  it('formats both dates as plain YYYY-MM-DD, joined by "to"', () => {
    const label = formatPeriodLabel(new Date('2026-07-02T12:00:00.000Z'), FIXED_NOW);
    expect(label).toBe('2026-07-02 to 2026-07-09');
  });
});
