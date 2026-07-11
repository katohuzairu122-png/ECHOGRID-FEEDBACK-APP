export type PeriodType = 'weekly' | 'monthly';

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

  if (periodType === 'weekly') {
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
