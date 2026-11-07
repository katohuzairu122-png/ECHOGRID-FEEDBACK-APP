import { describe, expect, it } from 'vitest';
import { isPlatformJob } from './platform-job-validation';

const base = {
  type: 'generate_summary',
  businessId: 'business-a',
  periodType: 'daily',
  periodStart: '2026-11-01T00:00:00Z',
  periodEnd: '2026-11-02T00:00:00Z',
};

describe('DEV-60 canonical summary-period timestamps', () => {
  it.each([
    ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'],
    ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.001Z'],
    ['2024-02-29T12:03:04.567Z', '2024-03-01T00:00:00.000Z'],
  ])('accepts valid queue-producer UTC timestamps: %s', (periodStart, periodEnd) => {
    expect(isPlatformJob({ ...base, periodStart, periodEnd })).toBe(true);
  });

  it.each([
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-11-01T24:00:00Z',
    '2026-11-01T23:60:00Z',
    '2026-11-01T23:59:60Z',
    '2026-11-01',
    '2026-11-01T00:00:00+00:00',
    '2026-11-01T00:00:00.00Z',
    '2026-11-01T00:00:00.0000Z',
    '2026-11-01T00:00:00z',
    ' 2026-11-01T00:00:00Z',
    '2026-11-01T00:00:00Z ',
    '2026-11-01T00:00:00Z\nprivate',
    'not a timestamp',
    '',
  ])('rejects unsupported or normalized-invalid periodStart %s', periodStart => {
    expect(isPlatformJob({ ...base, periodStart })).toBe(false);
  });

  it('rejects impossible periodEnd and chronological inversions', () => {
    expect(isPlatformJob({ ...base, periodEnd: '2026-02-30T12:00:00Z' })).toBe(false);
    expect(isPlatformJob({ ...base, periodStart: base.periodEnd })).toBe(false);
    expect(isPlatformJob({ ...base, periodEnd: base.periodStart })).toBe(false);
  });

  it.each([null, 1, false, {}, ['2026-11-01T00:00:00Z']])(
    'rejects non-string queue period start %#', periodStart => {
      expect(isPlatformJob({ ...base, periodStart })).toBe(false);
    },
  );
});
