import { and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { Bindings } from '../../config/env';
import { createDb, type Database } from '../../db/client';
import { stripeEvidenceControlEvents, stripeProviderEvents } from '../../db/schema';
import { checkKeyring, resolveConfig, streamForEnv, type CaptureEnv, type PreconditionCode } from './capture.config';
import { ControlEventWriter } from './control-events';
import { SLOT_SECONDS, DEFAULT_UCW_PARAMS, deriveUcw, heartbeatKey, planMaterialization, slotOf, type UcwEvent, type UcwParams } from './ucw';

/**
 * HETA-01-F1 E.3: heartbeat writer (existing `* /5` cron), mode-change recorder and UCW materialization.
 * The heartbeat attests only the Worker's own state, never Stripe's delivery completeness, and a compromised
 * Worker could forge it (E.3 limits). Materialized events are caches of deriveUcw; the derivation is authoritative.
 */
export type ReportedMode = 'off' | 'enforced' | 'invalid';
const HEARTBEAT_HISTORY_DAYS = 7;

export function reportedMode(env: CaptureEnv): ReportedMode {
  const v = env.STRIPE_EVIDENCE_CAPTURE;
  return v === 'enforced' ? 'enforced' : v === 'off' || v === '' ? 'off' : 'invalid';
}

export interface HeartbeatResult { inserted: boolean; healthy: boolean; slot: number; stream: string }

export async function writeHeartbeat(db: Database, env: CaptureEnv, scheduledTimeMs: number, now: Date): Promise<HeartbeatResult> {
  const stream = streamForEnv(env);
  const slot = slotOf(scheduledTimeMs);
  const mode = reportedMode(env);
  const cfg = resolveConfig(env);
  const configFailures: PreconditionCode[] = cfg.ok ? [] : cfg.failures.filter(f => f !== 'CAPTURE_MODE_INVALID' || mode !== 'off');
  const keyring = mode === 'enforced' ? await checkKeyring(env, now) : null;
  const control = new ControlEventWriter(db);
  const att = mode === 'enforced' ? await control.latestAttestation(stream) : null;
  const l2MaxAge = cfg.ok ? cfg.cfg.l2MaxAgeSeconds : 86_400;
  const attestationCurrent = Boolean(att && att.passed && now.getTime() - att.occurredAt.getTime() <= l2MaxAge * 1000);
  const keyringValid = keyring?.ok === true || (keyring?.ok === false && keyring.detail === 'KEYRING_NO_RUNWAY');
  const runwayCohorts = keyring?.ok ? keyring.keyring.runwayCohorts(now) : 0;
  const checks = {
    configOk: configFailures.length === 0,
    attestationCurrent,
    keyringValid,
    runwayOk: keyring?.ok === true,
    retentionApproved: !configFailures.includes('RETENTION_UNAPPROVED'),
    projectionLegacy: !configFailures.includes('PROJECTION_MODE_NOT_LEGACY'),
  };
  const healthy = mode === 'enforced' && Object.values(checks).every(Boolean);

  const last = cfg.ok
    ? (await db.select({ at: sql<Date | null>`max(${stripeProviderEvents.receivedAt})` }).from(stripeProviderEvents).where(eq(stripeProviderEvents.receivingAccountId, cfg.cfg.receivingAccountId)))[0]?.at ?? null
    : null;
  const inserted = await control.append({
    kind: 'capture_heartbeat', actor: 'cron', stream, dedupeKey: heartbeatKey(stream, slot),
    details: {
      slot, slotStartEpoch: slot * SLOT_SECONDS, mode, healthy, checks, runwayCohorts, configFailures,
      keyringCode: keyring && !keyring.ok ? keyring.detail : null,
      retentionPolicyVersion: env.EVIDENCE_RETENTION_POLICY_VERSION ?? null,
      lastCaptureReceivedAt: last ? new Date(last).toISOString() : null,
    },
  });
  return { inserted, healthy, slot, stream };
}

/** Deploy pipeline / operator: every capture-mode change is appended with its effective time (T23). */
export async function recordModeChange(db: Database, p: { stream: string; from: string; to: 'off' | 'enforced'; effectiveAt: Date; actor: string; commitSha?: string; approvalRef?: string }): Promise<boolean> {
  return new ControlEventWriter(db).append({
    kind: 'capture_mode_changed', actor: p.actor, stream: p.stream, windowStart: p.effectiveAt, commitSha: p.commitSha, approvalRef: p.approvalRef,
    dedupeKey: `mode:${p.stream}:${p.to}:${Math.floor(p.effectiveAt.getTime() / 1000)}`, details: { from: p.from, to: p.to },
  });
}

const toUcw = (r: typeof stripeEvidenceControlEvents.$inferSelect): UcwEvent => ({
  seq: r.seq, kind: r.eventKind, stream: r.stream, occurredAt: r.occurredAt, windowStart: r.windowStart, windowEnd: r.windowEnd, details: r.details,
});

/**
 * Loads one stream's source events for derivation: every non-heartbeat event, heartbeats from the last
 * HEARTBEAT_HISTORY_DAYS, plus the newest older heartbeat (and newest older healthy one) so a gap that began before
 * the window is still detected. Older gaps were materialized when they were first observed.
 */
export async function loadStreamEvents(db: Database, stream: string, now: Date, historyDays = HEARTBEAT_HISTORY_DAYS): Promise<UcwEvent[]> {
  const c = stripeEvidenceControlEvents;
  const cutoff = new Date(now.getTime() - historyDays * 86_400_000);
  const cutoffSlot = slotOf(cutoff.getTime());
  const slotOfDetails = sql<number>`(${c.details}->>'slot')::bigint`;
  // Sequential on purpose: one pg Client must not run overlapping queries.
  const others = await db.select().from(c).where(and(eq(c.stream, stream), ne(c.eventKind, 'capture_heartbeat'))).orderBy(asc(c.seq));
  const recent = await db.select().from(c).where(and(eq(c.stream, stream), eq(c.eventKind, 'capture_heartbeat'), gte(slotOfDetails, cutoffSlot))).orderBy(asc(c.seq));
  const olderLatest = await db.select().from(c).where(and(eq(c.stream, stream), eq(c.eventKind, 'capture_heartbeat'), lt(slotOfDetails, cutoffSlot))).orderBy(desc(slotOfDetails)).limit(1);
  const olderHealthy = await db.select().from(c).where(and(eq(c.stream, stream), eq(c.eventKind, 'capture_heartbeat'), lt(slotOfDetails, cutoffSlot), sql`${c.details}->>'healthy' = 'true'`)).orderBy(desc(slotOfDetails)).limit(1);
  const byId = new Map([...others, ...recent, ...olderLatest, ...olderHealthy].map(r => [r.id, r]));
  return [...byId.values()].map(toUcw).sort((a, b) => a.seq - b.seq);
}

/** Layer 1 (E.3): derive, then append the cache events that are missing. Concurrent detectors write one row per dedupe key. */
export async function materializeUcw(db: Database, stream: string, now: Date, params: UcwParams = DEFAULT_UCW_PARAMS): Promise<{ planned: number; inserted: number }> {
  const intervals = deriveUcw(await loadStreamEvents(db, stream, now), stream, now, params);
  const plan = planMaterialization(stream, intervals);
  const control = new ControlEventWriter(db);
  let inserted = 0;
  for (const p of plan) {
    if (await control.append({ kind: p.kind, actor: 'cron', stream: p.stream, cause: p.cause, dedupeKey: p.dedupeKey, windowStart: p.windowStart, windowEnd: p.windowEnd, details: { derived: true } })) inserted++;
  }
  return { planned: plan.length, inserted };
}

/**
 * The scheduled job. Does nothing when STRIPE_EVIDENCE_CAPTURE is unset, so a deployment that has not applied
 * migration 0045 and has not set the flag never touches the evidence tables.
 */
export async function runStripeEvidenceHeartbeat(env: Bindings, scheduledTimeMs: number): Promise<HeartbeatResult | null> {
  if (env.STRIPE_EVIDENCE_CAPTURE === undefined) return null;
  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    const now = new Date();
    const r = await writeHeartbeat(db, env, scheduledTimeMs, now);
    await materializeUcw(db, r.stream, now);
    return r;
  } finally {
    await close();
  }
}
