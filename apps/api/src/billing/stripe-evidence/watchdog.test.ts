import { describe, it, expect } from 'vitest';
import { evaluateWatchdog, DEFAULT_WATCHDOG_PARAMS, type WatchdogCode } from './watchdog';
import { SLOT_SECONDS, slotOf, type UcwEvent } from './ucw';
import { reportedMode, runStripeEvidenceHeartbeat } from './heartbeat';
import { isCaptureOff } from './capture.config';

const STREAM = 'acct_W:false';
const NOW = new Date('2026-10-10T12:00:00Z');
const nowSlot = slotOf(NOW.getTime());
let seq = 0;
const base = (kind: string, details: Record<string, unknown>, extra: Partial<UcwEvent> = {}): UcwEvent => ({
  seq: ++seq, kind, stream: STREAM, occurredAt: new Date(), windowStart: null, windowEnd: null, details, ...extra,
});
const hb = (slot: number, over: Record<string, unknown> = {}) => base('capture_heartbeat', { slot, mode: 'enforced', healthy: true, runwayCohorts: 2, checks: {}, ...over });
const recon = (endAgoSeconds: number) => base('reconciliation_run', { state: 'reconciled_no_known_gaps' }, { windowEnd: new Date(NOW.getTime() - endAgoSeconds * 1000) });
const healthyRun = (): UcwEvent[] => [
  base('capture_mode_changed', { to: 'enforced' }, { windowStart: new Date((nowSlot - 40) * SLOT_SECONDS * 1000) }),
  ...Array.from({ length: 30 }, (_, i) => hb(nowSlot - 29 + i)),
  recon(3600),
];
const codes = (e: UcwEvent[], now = NOW) => evaluateWatchdog(e, STREAM, now).map(a => a.code).sort();

describe('watchdog evaluation (E.3 layer 2, T21)', () => {
  it('a healthy stream raises nothing', () => {
    expect(codes(healthyRun())).toEqual([]);
  });

  it('no heartbeats at all is critical', () => {
    expect(codes([recon(60)])).toContain<WatchdogCode>('NO_HEARTBEATS');
  });

  it('a stale heartbeat raises HEARTBEAT_STALE and an open gap UCW without waiting for the Worker to resume', () => {
    const events = healthyRun();
    const later = new Date(NOW.getTime() + 30 * 60_000);
    const out = codes(events, later);
    expect(out).toContain('HEARTBEAT_STALE');
    expect(out).toContain('UCW_OPEN');
  });

  it('an unhealthy enforced heartbeat raises HEARTBEAT_UNHEALTHY (and an open precondition UCW)', () => {
    const events = [...healthyRun().slice(0, -2), hb(nowSlot, { healthy: false, checks: { keyringValid: false }, configFailures: ['RETENTION_UNAPPROVED'] }), recon(60)];
    const out = evaluateWatchdog(events, STREAM, NOW);
    expect(out.map(a => a.code)).toEqual(expect.arrayContaining(['HEARTBEAT_UNHEALTHY', 'UCW_OPEN']));
    expect(JSON.stringify(out)).not.toMatch(/whsec_|sk_|"key"/);
  });

  it('a stale or missing reconciliation raises RECONCILIATION_STALE (warning)', () => {
    expect(codes(healthyRun().filter(e => e.kind !== 'reconciliation_run'))).toContain('RECONCILIATION_STALE');
    const old = [...healthyRun().filter(e => e.kind !== 'reconciliation_run'), recon(DEFAULT_WATCHDOG_PARAMS.maxReconciliationAgeSeconds + 60)];
    const a = evaluateWatchdog(old, STREAM, NOW).find(x => x.code === 'RECONCILIATION_STALE');
    expect(a?.severity).toBe('warning');
    expect(codes([...healthyRun().filter(e => e.kind !== 'reconciliation_run'), recon(60)])).not.toContain('RECONCILIATION_STALE');
  });

  it('low KEK runway raises KEK_RUNWAY_LOW; a missing runway report is treated as low', () => {
    const events = healthyRun();
    events[events.length - 2] = hb(nowSlot, { runwayCohorts: 0 });
    expect(codes(events)).toContain('KEK_RUNWAY_LOW');
    const noField = healthyRun();
    noField[noField.length - 2] = hb(nowSlot, { runwayCohorts: undefined });
    expect(codes(noField)).toContain('KEK_RUNWAY_LOW');
  });

  it('other streams are ignored', () => {
    const events = healthyRun().map(e => ({ ...e, stream: 'acct_OTHER:false' }));
    expect(codes(events)).toContain('NO_HEARTBEATS');
  });
});

describe('heartbeat job gating', () => {
  it('reports the capture mode truthfully, including an invalid value', () => {
    expect(reportedMode({ STRIPE_EVIDENCE_CAPTURE: 'enforced' })).toBe('enforced');
    expect(reportedMode({ STRIPE_EVIDENCE_CAPTURE: 'off' })).toBe('off');
    expect(reportedMode({ STRIPE_EVIDENCE_CAPTURE: 'ENFORCED' })).toBe('invalid');
  });

  it('is a no-op that never opens a database connection when STRIPE_EVIDENCE_CAPTURE is unset', async () => {
    // HYPERDRIVE is deliberately absent: touching it would throw.
    await expect(runStripeEvidenceHeartbeat({} as never, Date.now())).resolves.toBeNull();
  });

  // B1: the heartbeat must share the webhook route's capture-off predicate. The HYPERDRIVE binding records every read, so
  // "no database access" is asserted directly rather than inferred from the return value.
  const envWith = (capture: string | undefined) => {
    const reads: string[] = [];
    const env = new Proxy({ ...(capture === undefined ? {} : { STRIPE_EVIDENCE_CAPTURE: capture }) } as Record<string, unknown>, {
      get(t, k) {
        if (k === 'HYPERDRIVE') { reads.push('HYPERDRIVE'); return { connectionString: 'postgresql://unreachable.invalid/none' }; }
        return t[k as string];
      },
    });
    return { env: env as never, reads };
  };

  it.each([['unset', undefined], ['empty string', ''], ['off', 'off']] as const)('capture %s: returns null and never reads the database binding', async (_n, v) => {
    const { env, reads } = envWith(v);
    await expect(runStripeEvidenceHeartbeat(env, Date.now())).resolves.toBeNull();
    expect(reads).toEqual([]);
    expect(isCaptureOff(env)).toBe(true);
  });

  it.each([['enforced', 'enforced'], ['invalid value', 'on'], ['wrong case', 'OFF'], ['whitespace', ' off']] as const)('capture %s: is NOT treated as disabled and proceeds toward the database', async (_n, v) => {
    const { env, reads } = envWith(v);
    expect(isCaptureOff(env)).toBe(false);
    await expect(runStripeEvidenceHeartbeat(env, Date.now())).rejects.toBeDefined(); // unreachable host: the path was entered
    expect(reads).toEqual(['HYPERDRIVE']);
  });
});
