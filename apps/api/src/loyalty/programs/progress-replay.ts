import {
  applyMilestone,
  applyMissions,
  applyStamp,
  applyStreak,
  milestoneStateFrom,
  missionStateFrom,
  stampStateFrom,
  streakStateFrom,
  type LoyaltyProgramType,
  type ProgressEvent,
} from '@echo-grid-feedback/shared-types';

/** One event that was applied to a customer's progress, in the order it was applied, with the configuration version it was applied under. */
export interface ReplayStep {
  config: Record<string, unknown>;
  event: ProgressEvent;
}
export interface ReplayResult {
  counters: Record<string, unknown>;
  /** Every reward grant the history yields, by its stable entitlement key. */
  grants: Map<string, string>;
}

/**
 * LPC-08: derives a customer's progress from the history of events applied to it, using the SAME pure engines that applied them live. Reversing a
 * purchase replays the history without it. Only events that were recorded as applied are replayed (an event that changed nothing at the time was
 * never recorded and stays a no-op), which errs on the side of the business, never grants more than the live run did, and is checked against the
 * stored counters before any reversal is allowed.
 */
export function replayProgress(type: LoyaltyProgramType, steps: readonly ReplayStep[], timeZone: string): ReplayResult {
  const grants = new Map<string, string>();
  let counters: Record<string, unknown> = {};
  for (const step of steps) {
    const { config, event } = step;
    if (type === 'LP-01') {
      if (event.kind !== 'purchase') continue;
      const outcome = applyStamp(config, stampStateFrom(counters), { amountMinor: event.amountMinor, currency: event.currency, now: event.occurredAt });
      if (!outcome.stamped) continue;
      counters = { ...outcome.state };
      if (outcome.completedCycle !== null) grants.set(`cycle:${outcome.completedCycle}`, String(config.rewardId));
      continue;
    }
    const outcome =
      type === 'LP-04' ? applyMilestone(config, milestoneStateFrom(counters), event)
      : type === 'LP-05' ? applyStreak(config, streakStateFrom(counters), event, timeZone)
      : type === 'LP-07' ? applyMissions(config, missionStateFrom(counters), event)
      : null;
    if (!outcome || outcome.steps.length === 0) continue;
    counters = { ...outcome.state } as Record<string, unknown>;
    for (const grant of outcome.grants) grants.set(grant.key, grant.rewardId);
  }
  return { counters, grants };
}

/** True when two counters objects describe the same progress (key order and undefined values do not matter). */
export function sameCounters(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  const norm = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(norm);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, norm(v)]));
    }
    return value;
  };
  return JSON.stringify(norm(a ?? {})) === JSON.stringify(norm(b ?? {}));
}
