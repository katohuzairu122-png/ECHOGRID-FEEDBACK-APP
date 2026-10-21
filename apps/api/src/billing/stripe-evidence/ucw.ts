/**
 * HETA-01-F1 E.2: Uncertified Coverage Window (UCW) derivation. PURE: a function of a set of control events,
 * the stream, the parameters and an evaluation time. No database, no clock, no I/O.
 *
 * Coverage is NEVER certified here. HEALTHY_OBSERVED means only "no uncertified interval covers this instant".
 * Intervals are monotone: nothing removes or shrinks one; a closed interval stays UNCERTIFIED forever and the
 * identities and counts of provider events inside it are UNKNOWN (reports say so; they never infer a count).
 *
 * Determinism: all boundaries come from timestamps EMBEDDED in events (heartbeat slot time, bucket start,
 * mode-change effective time, reconciliation window), never from the evaluation clock except for the open end of
 * an interval and a trailing heartbeat gap. Heartbeats and buckets are processed in embedded-time order and
 * merged by union, which is commutative and associative, so insertion order among concurrent writers cannot
 * change the result. Mode changes are the only seq-ordered inputs (ties on effective time break by seq).
 */
export const SLOT_SECONDS = 300;

export interface UcwParams {
  /** K: consecutive healthy heartbeats that close an interval (H15 default 3). */
  healthyStreakK: number;
  /** Missing 5-minute slots tolerated between heartbeats (H15 default 2). */
  gapToleranceSlots: number;
  /** R: retry horizon in seconds (H15 default 3 days). */
  retryHorizonSeconds: number;
}
export const DEFAULT_UCW_PARAMS: UcwParams = { healthyStreakK: 3, gapToleranceSlots: 2, retryHorizonSeconds: 3 * 86_400 };

export type UcwCause =
  | 'capture_off' | 'precondition_failed' | 'http_413' | 'http_500' | 'heartbeat_gap'
  | 'unrecorded_mode_change' | 'oversize_unresolved' | 'reconciliation_incomplete';

export interface UcwEvent {
  seq: number;
  kind: string;
  stream: string | null;
  occurredAt: Date;
  windowStart: Date | null;
  windowEnd: Date | null;
  details: Record<string, unknown>;
}

export interface UcwInterval {
  cause: UcwCause;
  start: Date;
  /** null = still open: extends to the evaluation time. */
  end: Date | null;
}

export type CoverageState = 'UNCERTIFIED' | 'HEALTHY_OBSERVED';

const SLOT_MS = SLOT_SECONDS * 1000;

interface Hb { t: number; slot: number; mode: string; healthy: boolean }

const asMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** Embedded boundary of an event (see header). `occurredAt` is only the last-resort fallback. */
function boundary(e: UcwEvent): number {
  switch (e.kind) {
    case 'capture_heartbeat': {
      const slot = e.details.slot;
      if (typeof slot === 'number' && Number.isInteger(slot)) return slot * SLOT_MS;
      break;
    }
    case 'capture_precondition_failed':
    case 'capture_error_observed':
    case 'oversize_rejected': {
      const b = asMs(e.details.bucketStart);
      if (b !== null) return b;
      break;
    }
  }
  return e.windowStart?.getTime() ?? asMs(e.details.at) ?? e.occurredAt.getTime();
}

function heartbeats(events: UcwEvent[]): Hb[] {
  const bySlot = new Map<number, Hb>();
  for (const e of events) {
    if (e.kind !== 'capture_heartbeat') continue;
    const slot = typeof e.details.slot === 'number' && Number.isInteger(e.details.slot) ? e.details.slot : Math.floor(boundary(e) / SLOT_MS);
    const mode = typeof e.details.mode === 'string' ? e.details.mode : 'unknown';
    const healthy = e.details.healthy === true && mode === 'enforced';
    const prev = bySlot.get(slot);
    // Two rows for one slot (cannot happen with the dedupe key; defensive): the unhealthy reading wins, conservatively.
    if (!prev || (prev.healthy && !healthy)) bySlot.set(slot, { t: slot * SLOT_MS, slot, mode, healthy });
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

interface ModeChange { t: number; seq: number; to: string }
function modeChanges(events: UcwEvent[]): ModeChange[] {
  return events
    .filter(e => e.kind === 'capture_mode_changed' && typeof e.details.to === 'string')
    .map(e => ({ t: boundary(e), seq: e.seq, to: e.details.to as string }))
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
}

/** End time (ms) of the first run of K consecutive qualifying heartbeats at or after `fromInclusive`, else null. */
function runEnd(hbs: Hb[], fromInclusive: number, p: UcwParams, qualifies: (h: Hb) => boolean): number | null {
  let run = 0;
  let prev: Hb | null = null;
  for (const h of hbs) {
    if (h.t < fromInclusive) continue;
    const contiguous = prev !== null && h.slot - prev.slot - 1 <= p.gapToleranceSlots;
    if (!qualifies(h)) { run = 0; prev = h; continue; }
    run = contiguous && run > 0 ? run + 1 : 1;
    prev = h;
    if (run >= p.healthyStreakK) return h.t;
  }
  return null;
}

/** Union of intervals per cause. Open ends are kept open; overlapping or touching intervals merge. */
function merge(cause: UcwCause, raw: { start: number; end: number | null }[]): UcwInterval[] {
  const s = [...raw].sort((a, b) => a.start - b.start || (a.end ?? Infinity) - (b.end ?? Infinity));
  const out: { start: number; end: number | null }[] = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && (last.end === null || i.start <= last.end)) {
      last.end = last.end === null || i.end === null ? null : Math.max(last.end, i.end);
    } else out.push({ ...i });
  }
  return out.map(i => ({ cause, start: new Date(i.start), end: i.end === null ? null : new Date(i.end) }));
}

/** Groups triggers (sorted times) into intervals that close only after a healthy run following the LAST trigger of the group. */
function triggerIntervals(triggers: number[], hbs: Hb[], p: UcwParams, qualifies: (h: Hb) => boolean): { start: number; end: number | null }[] {
  const ts = [...new Set(triggers)].sort((a, b) => a - b);
  const out: { start: number; end: number | null }[] = [];
  let i = 0;
  while (i < ts.length) {
    const start = ts[i]!;
    let last = start;
    let j = i + 1;
    for (;;) {
      const close = runEnd(hbs, last + 1, p, qualifies);
      const next = ts[j];
      if (next !== undefined && (close === null || next <= close)) { last = next; j++; continue; }
      out.push({ start, end: close });
      break;
    }
    i = j;
  }
  return out;
}

/**
 * Derives the UCW set for one stream. `events` may contain other streams and materialized cache events
 * (ucw_opened/ucw_closed/heartbeat_gap_detected); both are ignored: the derivation reads only source events.
 */
export function deriveUcw(allEvents: readonly UcwEvent[], stream: string, evaluatedAt: Date, params: UcwParams = DEFAULT_UCW_PARAMS): UcwInterval[] {
  const events = allEvents.filter(e => e.stream === stream || (e.stream === null && e.kind === 'capture_mode_changed' && e.details.stream === stream));
  if (events.length === 0) return [];
  const p = params;
  const hbs = heartbeats(events);
  const changes = modeChanges(events);
  const enforcedHealthy = (h: Hb) => h.healthy;
  const R = p.retryHorizonSeconds * 1000;
  const result: UcwInterval[] = [];

  // --- capture_off --------------------------------------------------------------------------
  const firstSource = events.filter(e => !['ucw_opened', 'ucw_closed', 'heartbeat_gap_detected'].includes(e.kind));
  if (firstSource.length > 0) {
    const b0 = Math.min(...firstSource.map(boundary));
    const timeline: { t: number; order: number; kind: 'off' | 'enforced' }[] = [
      ...changes.map(c => ({ t: c.t, order: c.seq, kind: (c.to === 'enforced' ? 'enforced' : 'off') as 'off' | 'enforced' })),
      ...hbs.filter(h => h.mode === 'off').map(h => ({ t: h.t, order: Number.MAX_SAFE_INTEGER, kind: 'off' as const })),
    ].sort((a, b) => a.t - b.t || a.order - b.order);
    const raw: { start: number; end: number | null }[] = [];
    let open: number | null = null;
    const firstChange = changes[0];
    if (!firstChange || firstChange.to !== 'enforced' || b0 < firstChange.t) open = firstChange && firstChange.to === 'off' && b0 >= firstChange.t ? firstChange.t : b0;
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i]!;
      if (item.kind === 'off') {
        if (open === null) open = item.t;
      } else if (open !== null) {
        const nextOff = timeline.slice(i + 1).find(x => x.kind === 'off');
        const close = runEnd(hbs, item.t + 1, p, enforcedHealthy);
        if (close !== null && (!nextOff || close < nextOff.t)) { raw.push({ start: open, end: close }); open = null; }
      }
    }
    if (open !== null) raw.push({ start: open, end: null });
    result.push(...merge('capture_off', raw));
  }

  // --- precondition_failed (buckets and unhealthy enforced heartbeats) -----------------------
  const pre = [
    ...events.filter(e => e.kind === 'capture_precondition_failed').map(boundary),
    ...hbs.filter(h => h.mode === 'enforced' && !h.healthy).map(h => h.t),
  ];
  if (pre.length > 0) result.push(...merge('precondition_failed', triggerIntervals(pre, hbs, p, enforcedHealthy)));

  // --- http_413 / http_500: [bucket - R, bucket] per bucket, unioned; permanent (never certified retroactively) ----
  for (const [kind, cause] of [['oversize_rejected', 'http_413'], ['capture_error_observed', 'http_500']] as const) {
    const raw = events.filter(e => e.kind === kind).map(e => { const t = boundary(e); return { start: t - R, end: t }; });
    if (raw.length > 0) result.push(...merge(cause, raw));
  }

  // --- heartbeat_gap -----------------------------------------------------------------------
  if (hbs.length > 0) {
    const raw: { start: number; end: number | null }[] = [];
    let lastGood: Hb | null = null;
    for (let i = 0; i < hbs.length; i++) {
      const h = hbs[i]!;
      const prev = hbs[i - 1];
      if (prev && h.slot - prev.slot - 1 > p.gapToleranceSlots) {
        const start = (lastGood ?? prev).t;
        raw.push({ start, end: runEnd(hbs, h.t, p, enforcedHealthy) });
      }
      if (h.healthy) lastGood = h;
    }
    const tail = hbs[hbs.length - 1]!;
    const currentSlot = Math.floor(evaluatedAt.getTime() / SLOT_MS);
    if (currentSlot - tail.slot - 1 > p.gapToleranceSlots) raw.push({ start: (lastGood ?? tail).t, end: null });
    if (raw.length > 0) result.push(...merge('heartbeat_gap', raw));
  }

  // --- unrecorded_mode_change ---------------------------------------------------------------
  if (hbs.length > 0) {
    const recordedAt = (t: number): string => {
      let mode = 'off'; // no recorded change yet: the recorded state is "not enforced"
      for (const c of changes) if (c.t <= t) mode = c.to; else break;
      return mode;
    };
    const triggers = hbs.filter(h => h.mode !== recordedAt(h.t)).map(h => h.t);
    if (triggers.length > 0) result.push(...merge('unrecorded_mode_change', triggerIntervals(triggers, hbs, p, h => h.healthy && h.mode === recordedAt(h.t))));
  }

  // --- reconciliation outcomes and unrecovered coverage gaps: permanent, no streak closes them -------
  const perm = new Map<UcwCause, { start: number; end: number | null }[]>();
  for (const e of events) {
    const isRunBad = e.kind === 'reconciliation_run' && (e.details.state === 'incomplete' || e.details.state === 'unrecovered_gap');
    if (e.kind !== 'coverage_gap_unrecovered' && !isRunBad) continue;
    if (!e.windowStart || !e.windowEnd) continue;
    const cause: UcwCause = e.details.cause === 'oversize_unresolved' ? 'oversize_unresolved' : 'reconciliation_incomplete';
    const list = perm.get(cause) ?? [];
    list.push({ start: e.windowStart.getTime(), end: e.windowEnd.getTime() });
    perm.set(cause, list);
  }
  for (const [cause, raw] of perm) result.push(...merge(cause, raw));

  return result.sort((a, b) => a.start.getTime() - b.start.getTime() || a.cause.localeCompare(b.cause));
}

/** UNCERTIFIED for any instant inside any interval (closed or open); otherwise HEALTHY_OBSERVED (never "certified"). */
export function coverageStateAt(intervals: readonly UcwInterval[], at: Date, evaluatedAt: Date): CoverageState {
  const t = at.getTime();
  return intervals.some(i => i.start.getTime() <= t && t <= (i.end ?? evaluatedAt).getTime()) ? 'UNCERTIFIED' : 'HEALTHY_OBSERVED';
}

export interface CoverageReport {
  stream: string;
  evaluatedAt: string;
  state: CoverageState;
  uncertifiedIntervals: { cause: UcwCause; start: string; end: string | null; open: boolean }[];
  /** Always the literal 'unknown': the identities and counts of provider events inside a UCW are not reconstructable (E.4). */
  eventsMissedDuringUncertifiedWindows: 'unknown';
  statement: string;
}

export function coverageReport(stream: string, intervals: readonly UcwInterval[], evaluatedAt: Date): CoverageReport {
  return {
    stream,
    evaluatedAt: evaluatedAt.toISOString(),
    state: coverageStateAt(intervals, evaluatedAt, evaluatedAt),
    uncertifiedIntervals: intervals.map(i => ({ cause: i.cause, start: i.start.toISOString(), end: i.end?.toISOString() ?? null, open: i.end === null })),
    eventsMissedDuringUncertifiedWindows: 'unknown',
    statement: 'Coverage is not certified. Heartbeats attest only the Worker\'s own state. Events inside any uncertified window are unknown, not zero.',
  };
}

// ---- deterministic materialization keys (E.2 Idempotency) -----------------------------------------
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
export const heartbeatKey = (stream: string, slot: number) => `hb:${stream}:${slot}`;
export const gapKey = (stream: string, lastGoodSlot: number) => `gap:${stream}:${lastGoodSlot}`;
export const openKey = (stream: string, cause: UcwCause, start: Date) => `ucw:${stream}:${cause}:${sec(start)}`;
export const closeKey = (open: string, end: Date) => `ucwc:${open}:${sec(end)}`;
export const slotOf = (ms: number) => Math.floor(ms / SLOT_MS);

export interface PlannedControlEvent {
  kind: 'ucw_opened' | 'ucw_closed' | 'heartbeat_gap_detected';
  dedupeKey: string;
  cause: UcwCause;
  stream: string;
  windowStart: Date;
  windowEnd?: Date;
}

/** Materialized events are caches of deriveUcw; the derivation stays authoritative. Same intervals give the same keys. */
export function planMaterialization(stream: string, intervals: readonly UcwInterval[]): PlannedControlEvent[] {
  const plan: PlannedControlEvent[] = [];
  for (const i of intervals) {
    const open = openKey(stream, i.cause, i.start);
    if (i.cause === 'heartbeat_gap') plan.push({ kind: 'heartbeat_gap_detected', dedupeKey: gapKey(stream, slotOf(i.start.getTime())), cause: i.cause, stream, windowStart: i.start });
    plan.push({ kind: 'ucw_opened', dedupeKey: open, cause: i.cause, stream, windowStart: i.start });
    if (i.end) plan.push({ kind: 'ucw_closed', dedupeKey: closeKey(open, i.end), cause: i.cause, stream, windowStart: i.start, windowEnd: i.end });
  }
  return plan;
}
