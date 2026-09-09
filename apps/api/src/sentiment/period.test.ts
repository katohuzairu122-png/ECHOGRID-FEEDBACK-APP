import { describe, it, expect } from 'vitest';
import { computePeriodRange, computePreviousPeriodRange, formatPeriodLabel } from './period';

const FIXED_NOW = new Date('2026-07-09T12:00:00.000Z');

describe('computePeriodRange', () => {
  it('daily: periodStart is exactly 1 day before periodEnd', () => {
    const { periodStart, periodEnd } = computePeriodRange('daily', FIXED_NOW);
    expect(periodEnd.toISOString()).toBe(FIXED_NOW.toISOString());
    expect(periodStart.toISOString()).toBe('2026-07-08T12:00:00.000Z');
  });

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

describe('computePreviousPeriodRange', () => {
  it('weekly: returns the 7 days immediately before periodStart, same duration', () => {
    const current = computePeriodRange('weekly', FIXED_NOW);
    const previous = computePreviousPeriodRange(current.periodStart, current.periodEnd);

    expect(previous.periodEnd.toISOString()).toBe(current.periodStart.toISOString());
    expect(previous.periodStart.toISOString()).toBe('2026-06-25T12:00:00.000Z');
  });

  it('daily: returns the 1 day immediately before periodStart', () => {
    const current = computePeriodRange('daily', FIXED_NOW);
    const previous = computePreviousPeriodRange(current.periodStart, current.periodEnd);

    expect(previous.periodEnd.toISOString()).toBe(current.periodStart.toISOString());
    expect(previous.periodStart.toISOString()).toBe('2026-07-07T12:00:00.000Z');
  });

  it('is contiguous with the current period -- no gap and no overlap', () => {
    const current = { periodStart: new Date('2026-07-02T12:00:00.000Z'), periodEnd: FIXED_NOW };
    const previous = computePreviousPeriodRange(current.periodStart, current.periodEnd);

    expect(previous.periodEnd.getTime()).toBe(current.periodStart.getTime());
  });

  it('does not mutate the arguments passed in', () => {
    const periodStart = new Date('2026-07-02T12:00:00.000Z');
    const periodEnd = new Date(FIXED_NOW);
    computePreviousPeriodRange(periodStart, periodEnd);
    expect(periodStart.toISOString()).toBe('2026-07-02T12:00:00.000Z');
    expect(periodEnd.toISOString()).toBe(FIXED_NOW.toISOString());
  });
});

describe('formatPeriodLabel', () => {
  it('formats both dates as plain YYYY-MM-DD, joined by "to"', () => {
    const label = formatPeriodLabel(new Date('2026-07-02T12:00:00.000Z'), FIXED_NOW);
    expect(label).toBe('2026-07-02 to 2026-07-09');
  });
});
