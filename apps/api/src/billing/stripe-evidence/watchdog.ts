import { deriveUcw, DEFAULT_UCW_PARAMS, SLOT_SECONDS, type UcwEvent, type UcwParams } from './ucw';

/**
 * HETA-01-F1 E.3 layer 2: the external watchdog's evaluation, as a PURE function over control events.
 * The scheduling host, the read-only database role (SELECT on the control-events table only) and the independent
 * alert channel are deployment decisions (H15) and are NOT provisioned by this repository. It evaluates the
 * E.2 derivation directly; it does not depend on the Worker's own materialized events.
 */
export interface WatchdogParams {
  ucw: UcwParams;
  /** Alert when the newest heartbeat is older than this many seconds. */
  maxHeartbeatAgeSeconds: number;
  /** Alert when no successful reconciliation run is newer than this (k x cadence, H16). */
  maxReconciliationAgeSeconds: number;
  /** Alert when fewer than this many next-cohort KEKs remain. */
  minRunwayCohorts: number;
}

export const DEFAULT_WATCHDOG_PARAMS: WatchdogParams = {
  ucw: DEFAULT_UCW_PARAMS,
  maxHeartbeatAgeSeconds: (DEFAULT_UCW_PARAMS.gapToleranceSlots + 1) * SLOT_SECONDS,
  maxReconciliationAgeSeconds: 3 * 86_400,
  minRunwayCohorts: 1,
};

export type WatchdogCode = 'NO_HEARTBEATS' | 'HEARTBEAT_STALE' | 'HEARTBEAT_UNHEALTHY' | 'UCW_OPEN' | 'RECONCILIATION_STALE' | 'KEK_RUNWAY_LOW';
export interface WatchdogAlert {
  code: WatchdogCode;
  severity: 'critical' | 'warning';
  /** Non-secret facts only (ages, causes, counts). */
  detail: Record<string, unknown>;
}

export function evaluateWatchdog(events: readonly UcwEvent[], stream: string, now: Date, params: WatchdogParams = DEFAULT_WATCHDOG_PARAMS): WatchdogAlert[] {
  const mine = events.filter(e => e.stream === stream);
  const alerts: WatchdogAlert[] = [];
  const heartbeats = mine.filter(e => e.kind === 'capture_heartbeat' && typeof e.details.slot === 'number').sort((a, b) => (a.details.slot as number) - (b.details.slot as number));
  const latest = heartbeats[heartbeats.length - 1];

  if (!latest) {
    alerts.push({ code: 'NO_HEARTBEATS', severity: 'critical', detail: {} });
  } else {
    const ageSeconds = Math.floor(now.getTime() / 1000) - (latest.details.slot as number) * SLOT_SECONDS;
    if (ageSeconds > params.maxHeartbeatAgeSeconds) alerts.push({ code: 'HEARTBEAT_STALE', severity: 'critical', detail: { ageSeconds, maxAgeSeconds: params.maxHeartbeatAgeSeconds } });
    if (latest.details.mode === 'enforced' && latest.details.healthy !== true) {
      alerts.push({ code: 'HEARTBEAT_UNHEALTHY', severity: 'critical', detail: { checks: latest.details.checks ?? null, configFailures: latest.details.configFailures ?? null } });
    }
    const runway = latest.details.runwayCohorts;
    if (latest.details.mode === 'enforced' && (typeof runway !== 'number' || runway < params.minRunwayCohorts)) {
      alerts.push({ code: 'KEK_RUNWAY_LOW', severity: 'critical', detail: { runwayCohorts: typeof runway === 'number' ? runway : null, required: params.minRunwayCohorts } });
    }
  }

  for (const i of deriveUcw(mine, stream, now, params.ucw).filter(x => x.end === null)) {
    alerts.push({ code: 'UCW_OPEN', severity: 'critical', detail: { cause: i.cause, since: i.start.toISOString() } });
  }

  const lastGood = mine.filter(e => e.kind === 'reconciliation_run' && e.details.state === 'reconciled_no_known_gaps')
    .map(e => (e.windowEnd ?? e.occurredAt).getTime()).sort((a, b) => b - a)[0];
  if (lastGood === undefined || (now.getTime() - lastGood) / 1000 > params.maxReconciliationAgeSeconds) {
    alerts.push({ code: 'RECONCILIATION_STALE', severity: 'warning', detail: { lastSuccessfulRunWindowEnd: lastGood === undefined ? null : new Date(lastGood).toISOString(), maxAgeSeconds: params.maxReconciliationAgeSeconds } });
  }
  return alerts;
}
