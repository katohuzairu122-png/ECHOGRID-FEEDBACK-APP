import { describe, it, expect } from 'vitest';
import {
  deriveUcw, coverageStateAt, coverageReport, planMaterialization, DEFAULT_UCW_PARAMS, SLOT_SECONDS, slotOf,
  openKey, closeKey, gapKey, heartbeatKey, type UcwEvent, type UcwInterval,
} from './ucw';

const STREAM = 'acct_T:false';
const BASE_SLOT = slotOf(Date.parse('2026-10-01T00:00:00Z'));
const slotTime = (s: number) => new Date(s * SLOT_SECONDS * 1000);
let seq = 0;
const ev = (kind: string, over: Partial<UcwEvent> & { details?: Record<string, unknown> } = {}): UcwEvent => ({
  seq: ++seq, kind, stream: STREAM, occurredAt: new Date('2099-01-01T00:00:00Z'), windowStart: null, windowEnd: null, details: {}, ...over,
});
const mode = (at: Date, to: 'off' | 'enforced') => ev('capture_mode_changed', { windowStart: at, details: { from: to === 'off' ? 'enforced' : 'off', to } });
const hb = (i: number, o: { mode?: string; healthy?: boolean } = {}) =>
  ev('capture_heartbeat', { details: { slot: BASE_SLOT + i, mode: o.mode ?? 'enforced', healthy: o.healthy ?? true } });
const heartbeats = (from: number, to: number, o: { mode?: string; healthy?: boolean } = {}) => Array.from({ length: to - from + 1 }, (_, k) => hb(from + k, o));
const bucket = (kind: string, i: number) => ev(kind, { details: { bucketStart: slotTime(BASE_SLOT + i).toISOString() } });
const enforcedFrom = (i: number) => mode(slotTime(BASE_SLOT + i), 'enforced');
const at = (i: number) => slotTime(BASE_SLOT + i);
const EVAL = (i: number) => slotTime(BASE_SLOT + i);
const summary = (xs: UcwInterval[]) => xs.map(x => `${x.cause}:${x.start.toISOString()}..${x.end?.toISOString() ?? 'open'}`);
const only = (xs: UcwInterval[], cause: string) => xs.filter(x => x.cause === cause);

describe('UCW derivation (E.2, T43)', () => {
  it('healthy enforced run with a recorded start has no uncertified interval', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 30)];
    const out = deriveUcw(events, STREAM, EVAL(30));
    expect(out).toEqual([]);
    expect(coverageStateAt(out, at(10), EVAL(30))).toBe('HEALTHY_OBSERVED');
  });

  it('T22: capture never enforced (S0) is uncertified from the first event, open, and enforcement closes it only after K healthy heartbeats', () => {
    const noMode = deriveUcw([...heartbeats(0, 5, { mode: 'off', healthy: false })], STREAM, EVAL(5));
    expect(only(noMode, 'capture_off')).toEqual([{ cause: 'capture_off', start: at(0), end: null }]);
    const enforcedEarly = [...heartbeats(0, 2, { mode: 'off', healthy: false }), enforcedFrom(3), hb(4), hb(5)];
    expect(only(deriveUcw(enforcedEarly, STREAM, EVAL(5)), 'capture_off')[0]!.end).toBeNull(); // only 2 healthy heartbeats after the change
    const closed = [...enforcedEarly, hb(6)];
    const iv = only(deriveUcw(closed, STREAM, EVAL(6)), 'capture_off');
    expect(iv).toEqual([{ cause: 'capture_off', start: at(0), end: at(6) }]); // ends at the K-th (3rd) healthy heartbeat strictly after the change
  });

  it('capture_off: a recorded switch to off opens an interval; a later enforce closes it after K healthy heartbeats; off again reopens', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 3), mode(at(4), 'off'), ...heartbeats(4, 6, { mode: 'off', healthy: false }), enforcedFrom(7), ...heartbeats(8, 10), mode(at(12), 'off')];
    const off = only(deriveUcw(events, STREAM, EVAL(13)), 'capture_off');
    expect(off).toEqual([{ cause: 'capture_off', start: at(4), end: at(10) }, { cause: 'capture_off', start: at(12), end: null }]);
  });

  it('a heartbeat reporting off while recorded enforced opens capture_off and unrecorded_mode_change', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 2), hb(3, { mode: 'off', healthy: false }), ...heartbeats(4, 6)];
    const out = deriveUcw(events, STREAM, EVAL(6));
    expect(only(out, 'unrecorded_mode_change')).toEqual([{ cause: 'unrecorded_mode_change', start: at(3), end: at(6) }]);
    expect(only(out, 'capture_off')[0]!.start).toEqual(at(3));
  });

  it('outage: missing slots beyond the tolerance open a gap from the LAST good slot; recovery needs K healthy heartbeats and ends at the K-th', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 10), ...heartbeats(20, 21)];
    const during = only(deriveUcw(events, STREAM, EVAL(21)), 'heartbeat_gap');
    expect(during).toEqual([{ cause: 'heartbeat_gap', start: at(10), end: null }]);
    const recovered = only(deriveUcw([...events, hb(22), hb(23)], STREAM, EVAL(23)), 'heartbeat_gap');
    expect(recovered).toEqual([{ cause: 'heartbeat_gap', start: at(10), end: at(22) }]);
  });

  it('gap tolerance: up to 2 missing slots is not a gap; 3 missing is', () => {
    const ok = deriveUcw([enforcedFrom(0), ...heartbeats(0, 4), ...heartbeats(7, 12)], STREAM, EVAL(12)); // slots 5,6 missing
    expect(only(ok, 'heartbeat_gap')).toEqual([]);
    const bad = deriveUcw([enforcedFrom(0), ...heartbeats(0, 4), ...heartbeats(8, 14)], STREAM, EVAL(14)); // slots 5,6,7 missing
    expect(only(bad, 'heartbeat_gap')).toHaveLength(1);
  });

  it('a trailing outage (no heartbeats since) is flagged at evaluation time without waiting for resume', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 5)];
    expect(only(deriveUcw(events, STREAM, EVAL(8)), 'heartbeat_gap')).toEqual([]); // 2 missing: tolerated
    expect(only(deriveUcw(events, STREAM, EVAL(9)), 'heartbeat_gap')).toEqual([{ cause: 'heartbeat_gap', start: at(5), end: null }]);
  });

  it('precondition buckets and unhealthy enforced heartbeats open an interval that closes K healthy heartbeats after the LAST one', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 3), bucket('capture_precondition_failed', 4), bucket('capture_precondition_failed', 5), hb(5, { healthy: false }), ...heartbeats(6, 8)];
    const iv = only(deriveUcw(events, STREAM, EVAL(8)), 'precondition_failed');
    expect(iv).toEqual([{ cause: 'precondition_failed', start: at(4), end: at(8) }]);
    // a later trigger after closure starts a NEW interval
    const again = only(deriveUcw([...events, bucket('capture_precondition_failed', 20), ...heartbeats(9, 23)], STREAM, EVAL(25)), 'precondition_failed');
    expect(again.map(x => [x.start, x.end])).toEqual([[at(4), at(8)], [at(20), at(23)]]);
  });

  it('413 and 500 intervals are [first bucket - R, last bucket], permanent, and never closed by healthy heartbeats', () => {
    const R = DEFAULT_UCW_PARAMS.retryHorizonSeconds * 1000;
    const events = [enforcedFrom(0), ...heartbeats(0, 30), bucket('oversize_rejected', 10), bucket('oversize_rejected', 12), bucket('capture_error_observed', 20)];
    const out = deriveUcw(events, STREAM, EVAL(30));
    expect(only(out, 'http_413')).toEqual([{ cause: 'http_413', start: new Date(at(10).getTime() - R), end: at(12) }]);
    expect(only(out, 'http_500')).toEqual([{ cause: 'http_500', start: new Date(at(20).getTime() - R), end: at(20) }]);
    expect(coverageStateAt(out, new Date(at(10).getTime() - R + 1), EVAL(30))).toBe('UNCERTIFIED');
  });

  it('incomplete or unrecovered reconciliation windows are permanent', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 20),
      ev('reconciliation_run', { windowStart: at(2), windowEnd: at(8), details: { state: 'incomplete' } }),
      ev('reconciliation_run', { windowStart: at(9), windowEnd: at(10), details: { state: 'reconciled_no_known_gaps' } }),
      ev('coverage_gap_unrecovered', { windowStart: at(12), windowEnd: at(15), details: { cause: 'oversize_unresolved' } })];
    const out = deriveUcw(events, STREAM, EVAL(20));
    expect(only(out, 'reconciliation_incomplete')).toEqual([{ cause: 'reconciliation_incomplete', start: at(2), end: at(8) }]);
    expect(only(out, 'oversize_unresolved')).toEqual([{ cause: 'oversize_unresolved', start: at(12), end: at(15) }]);
    expect(coverageStateAt(out, at(9), EVAL(20))).toBe('HEALTHY_OBSERVED'); // a clean run does not create or erase anything
  });

  it('overlapping causes form a union; each cause keeps its own interval', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 3), bucket('capture_precondition_failed', 4), ...heartbeats(10, 14)];
    const out = deriveUcw(events, STREAM, EVAL(14));
    const causes = new Set(out.map(x => x.cause));
    expect(causes.has('precondition_failed') && causes.has('heartbeat_gap')).toBe(true);
    for (const t of [4, 6, 10, 11]) expect(coverageStateAt(out, at(t), EVAL(14))).toBe('UNCERTIFIED');
  });

  it('monotone: adding any later events never removes or shrinks an interval, and a closed interval stays UNCERTIFIED forever', () => {
    const base = [enforcedFrom(0), ...heartbeats(0, 5), bucket('capture_precondition_failed', 6), ...heartbeats(7, 9)];
    const before = deriveUcw(base, STREAM, EVAL(9));
    const later = [...base, ...heartbeats(10, 200), bucket('capture_error_observed', 150)];
    const after = deriveUcw(later, STREAM, EVAL(200));
    for (const b of before) {
      const covering = after.find(a => a.cause === b.cause && a.start <= b.start && (a.end === null || (b.end !== null && a.end >= b.end)));
      expect(covering, summary([b]).join()).toBeTruthy();
    }
    expect(coverageStateAt(after, at(7), EVAL(200))).toBe('UNCERTIFIED');
  });

  it('T43 determinism: any permutation of concurrent heartbeats and buckets yields identical intervals', () => {
    const fixed = enforcedFrom(0);
    const concurrent = [...heartbeats(0, 8), ...heartbeats(15, 19), bucket('capture_precondition_failed', 9), bucket('oversize_rejected', 16), bucket('capture_error_observed', 17), hb(25, { healthy: false })];
    const expected = deriveUcw([fixed, ...concurrent], STREAM, EVAL(30));
    expect(expected.length).toBeGreaterThan(2);
    let s = 12345;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 50; n++) {
      const shuffled = concurrent.map(e => ({ ...e, seq: Math.floor(rnd() * 1e6) + 1000 })).sort(() => rnd() - 0.5);
      expect(summary(deriveUcw([fixed, ...shuffled], STREAM, EVAL(30)))).toEqual(summary(expected));
    }
  });

  it('ignores other streams and materialized cache events', () => {
    const other = { ...bucket('oversize_rejected', 3), stream: 'acct_OTHER:false' };
    const cache = ev('ucw_opened', { windowStart: at(1), details: {} });
    const out = deriveUcw([enforcedFrom(0), ...heartbeats(0, 10), other, cache], STREAM, EVAL(10));
    expect(out).toEqual([]);
  });

  it('empty stream: no events means no derived interval (and nothing is claimed)', () => {
    expect(deriveUcw([], STREAM, EVAL(1))).toEqual([]);
  });
});

describe('UCW reports (E.4): unknown stays unknown', () => {
  it('never contains a numeric count of missed events and states that coverage is not certified', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 3), bucket('oversize_rejected', 4), ...heartbeats(10, 12)];
    const out = deriveUcw(events, STREAM, EVAL(12));
    const report = coverageReport(STREAM, out, EVAL(12));
    expect(report.eventsMissedDuringUncertifiedWindows).toBe('unknown');
    expect(report.state).toBe('UNCERTIFIED');
    expect(report.statement).toMatch(/not certified/i);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/"(count|missed|total)[A-Za-z]*":\s*\d/);
    expect(coverageReport(STREAM, [], EVAL(1)).state).toBe('HEALTHY_OBSERVED');
  });
});

describe('materialization plan (E.2 idempotency)', () => {
  it('derives identical deterministic keys for identical intervals, so duplicate detectors write one event per key', () => {
    const events = [enforcedFrom(0), ...heartbeats(0, 10), ...heartbeats(20, 22), bucket('capture_precondition_failed', 25), ...heartbeats(23, 40)];
    const a = planMaterialization(STREAM, deriveUcw(events, STREAM, EVAL(30)));
    const b = planMaterialization(STREAM, deriveUcw([...events].reverse(), STREAM, EVAL(30)));
    expect(a).toEqual(b);
    const keys = a.map(e => e.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(gapKey(STREAM, BASE_SLOT + 10));
    expect(keys).toContain(openKey(STREAM, 'heartbeat_gap', at(10)));
    expect(keys.some(k => k.startsWith('ucwc:ucw:'))).toBe(true);
    expect(heartbeatKey(STREAM, BASE_SLOT)).toBe(`hb:${STREAM}:${BASE_SLOT}`);
    expect(closeKey('ucw:x', at(3))).toBe(`ucwc:ucw:x:${Math.floor(at(3).getTime() / 1000)}`);
  });

  it('opened/closed events carry only causes allowed by the control-event CHECK', () => {
    const allowed = new Set(['capture_off', 'precondition_failed', 'http_413', 'http_500', 'heartbeat_gap', 'oversize_unresolved', 'reconciliation_incomplete', 'unrecorded_mode_change']);
    const events = [hb(0, { mode: 'off', healthy: false }), bucket('oversize_rejected', 2), ev('coverage_gap_unrecovered', { windowStart: at(1), windowEnd: at(2) })];
    for (const e of planMaterialization(STREAM, deriveUcw(events, STREAM, EVAL(40)))) expect(allowed.has(e.cause)).toBe(true);
  });
});
