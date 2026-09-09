export type PeriodType = 'daily' | 'weekly' | 'monthly';

/**
 * Computes a [start, end) window ending at `now` (default: call time) --
 * shared by the cron handler (always "the period that just ended") and the
 * manual generate endpoint (Block 4), so both produce identically-shaped
 * periods instead of the on-demand path drifting from the automatic one.
 */
export function computePeriodRange(
  periodType: PeriodType,
  now: Date = new Date(),
): { periodStart: Date; periodEnd: Date } {
  const periodEnd = new Date(now);
  const periodStart = new Date(now);

  if (periodType === 'daily') {
    periodStart.setUTCDate(periodStart.getUTCDate() - 1);
  } else if (periodType === 'weekly') {
    periodStart.setUTCDate(periodStart.getUTCDate() - 7);
  } else {
    periodStart.setUTCMonth(periodStart.getUTCMonth() - 1);
  }

  return { periodStart, periodEnd };
}

/** Human-readable label for the summary prompt and, later, the dashboard UI. */
export function formatPeriodLabel(periodStart: Date, periodEnd: Date): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `${fmt(periodStart)} to ${fmt(periodEnd)}`;
}

/**
 * The immediately-preceding window of the same duration as
 * [periodStart, periodEnd) -- e.g. for a week-long period, the 7 days right
 * before it, with no gap and no overlap (previous periodEnd === this
 * periodStart exactly). Duration-based, not PeriodType-based, so it stays
 * correct for any period shape without needing to know which cadence
 * produced it (S4.1 "changes from previous periods", S4 roadmap Block 4).
 */
export function computePreviousPeriodRange(
  periodStart: Date,
  periodEnd: Date,
): { periodStart: Date; periodEnd: Date } {
  const durationMs = periodEnd.getTime() - periodStart.getTime();
  return {
    periodStart: new Date(periodStart.getTime() - durationMs),
    periodEnd: new Date(periodStart.getTime()),
  };
}
