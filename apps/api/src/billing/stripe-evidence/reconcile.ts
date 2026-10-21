import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { stripeEvidenceControlEvents, stripeProviderEvents } from '../../db/schema';
import { ControlEventWriter, streamOf } from './control-events';
import type { StripeEvidenceStore, Retention } from './evidence.store';
import { classifyEnvelope } from './shape';
import { coverageStateAt, deriveUcw } from './ucw';
import { loadStreamEvents } from './heartbeat';

/**
 * HETA-01-F1 D.3/D.4: bounded provider-list reconciliation and backfill. OPERATOR / privileged job only; runs under the
 * L2-verified restricted read-only key; never in the webhook request path.
 *
 * It lists provider event identities in an explicit window W, retrieves every identity ABSENT locally with
 * `events.retrieve` (exact response bytes) and ingests it as `api_retrieval` provenance with `retrieval_run_id`.
 * Every run appends a `reconciliation_run` manifest. A run that cannot reach `has_more = false` within its explicit
 * limits, sees an API error after bounded retries, an invalid page or an unstorable retrieval is INCOMPLETE and also
 * appends `coverage_gap_unrecovered`. Results are NEVER described as a complete provider history (D.4): Stripe states
 * no completeness guarantee [U], events older than the retrieval window are unrecoverable, and recovered rows do not
 * certify the window (E.4).
 */
export const RECONCILE_RULE = 'heta01-f1-reconcile/1';
export const DEFAULT_RETRIEVAL_HORIZON_SECONDS = 29 * 86_400; // Stripe retrieval window ~30 days [U]; one day of margin
export const DEFAULT_MAX_WINDOW_SECONDS = 7 * 86_400;
const NO_COMPLETENESS_CLAIM = 'A listing that reaches its end is not a complete provider history; events older than the retrieval window are unrecoverable; recovered rows do not certify the window.';

export interface ProviderListedEvent { id: string; type: string; created: number }
export interface ProviderEventSource {
  list(p: { createdGte: number; createdLt: number; types?: readonly string[] | undefined; limit: number; startingAfter?: string | undefined }): Promise<{ events: ProviderListedEvent[]; hasMore: boolean }>;
  /** Exact bytes of the provider response body. */
  retrieve(id: string): Promise<{ rawBody: string; apiVersion: string | null }>;
}

/** Thrown by sources. 4xx other than 429 is not retried. */
export class ProviderHttpError extends Error {
  constructor(public readonly status: number) { super(`Provider HTTP ${status}`); this.name = 'ProviderHttpError'; }
}
export class InvalidProviderPage extends Error {
  constructor() { super('Invalid provider page'); this.name = 'InvalidProviderPage'; }
}
export class ReconcileError extends Error {
  constructor(public readonly code: 'WINDOW_INVALID' | 'LIMITS_INVALID' | 'ATTESTATION_NOT_CURRENT') { super(`Reconciliation refused: ${code}`); this.name = 'ReconcileError'; }
}

export interface ReconcileParams {
  windowStart: Date;
  windowEnd: Date;
  pageSize: number;
  maxPages: number;
  maxEvents: number;
  types?: readonly string[] | undefined;
  maxAttempts?: number;
  backoffMs?: number;
  retrievalHorizonSeconds?: number;
  maxWindowSeconds?: number;
  l2MaxAgeSeconds?: number;
  /** List and compare only: no retrieval, no control events, no writes. */
  dryRun?: boolean;
}

export interface ReconcileDeps {
  db: Database;
  store: StripeEvidenceStore;
  source: ProviderEventSource;
  receivingAccountId: string;
  livemode: boolean;
  retention: Retention;
  actor: string;
  commitSha: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type ReconcileState = 'reconciled_no_known_gaps' | 'incomplete' | 'unrecovered_gap' | 'dry_run';
export interface ReconcileError1 { code: string; id?: string }
export interface ReconcileResult {
  state: ReconcileState;
  runId: string;
  startedEventId: string | null;
  pages: number;
  listed: number;
  presentLocally: number;
  absent: number;
  ingested: number;
  replayed: number;
  errors: ReconcileError1[];
  truncated: { pages: boolean; events: boolean };
  listedIdsDigest: string;
  statement: string;
}

const digest = (ids: string[]) => createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
const retryable = (e: unknown) => !(e instanceof ProviderHttpError) || e.status === 429 || e.status >= 500;
const errCode = (e: unknown) => (e instanceof ProviderHttpError ? `HTTP_${e.status}` : e instanceof InvalidProviderPage ? 'INVALID_PAGE' : e instanceof Error ? e.name : 'ERROR');

async function withRetry<T>(fn: () => Promise<T>, attempts: number, backoffMs: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!retryable(e) || i === attempts - 1) break;
      await sleep(backoffMs * 2 ** i);
    }
  }
  throw last;
}

export async function runReconciliation(deps: ReconcileDeps, p: ReconcileParams): Promise<ReconcileResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const t0 = now();
  const horizonSec = p.retrievalHorizonSeconds ?? DEFAULT_RETRIEVAL_HORIZON_SECONDS;
  const maxWindow = p.maxWindowSeconds ?? DEFAULT_MAX_WINDOW_SECONDS;
  const startS = Math.floor(p.windowStart.getTime() / 1000);
  const endS = Math.floor(p.windowEnd.getTime() / 1000);
  if (!(endS > startS) || p.windowEnd.getTime() > t0.getTime() || endS - startS > maxWindow) throw new ReconcileError('WINDOW_INVALID');
  if (!Number.isInteger(p.pageSize) || p.pageSize < 1 || p.pageSize > 100 || !Number.isInteger(p.maxPages) || p.maxPages < 1 || !Number.isInteger(p.maxEvents) || p.maxEvents < 1) throw new ReconcileError('LIMITS_INVALID');

  const stream = streamOf(deps.receivingAccountId, deps.livemode);
  const control = new ControlEventWriter(deps.db);
  const att = await control.latestAttestation(stream);
  if (!att || !att.passed || t0.getTime() - att.occurredAt.getTime() > (p.l2MaxAgeSeconds ?? 86_400) * 1000) throw new ReconcileError('ATTESTATION_NOT_CURRENT');

  const runId = randomUUID();
  const attempts = p.maxAttempts ?? 3;
  const backoff = p.backoffMs ?? 500;
  const errors: ReconcileError1[] = [];
  const addError = (code: string, id?: string) => { if (errors.length < 10) errors.push(id ? { code, id } : { code }); };

  // Part of the window older than the retrieval horizon is unrecoverable: record it, list only the recoverable part.
  const horizonStartS = Math.floor(t0.getTime() / 1000) - horizonSec;
  const clippedBefore = startS < horizonStartS ? Math.min(horizonStartS, endS) : null;
  const listFromS = clippedBefore !== null ? clippedBefore : startS;

  let startedEventId: string | null = null;
  const dry = p.dryRun === true;
  if (!dry) {
    const startKey = `recon-start:${stream}:${runId}`;
    await control.append({
      kind: 'reconciliation_run', actor: deps.actor, stream, commitSha: deps.commitSha ?? undefined, dedupeKey: startKey, windowStart: p.windowStart, windowEnd: p.windowEnd,
      details: { state: 'started', runId, pageSize: p.pageSize, maxPages: p.maxPages, maxEvents: p.maxEvents, types: p.types ?? null },
    });
    startedEventId = await findControlId(deps.db, startKey);
  }

  // ---- list (bounded, cursor-based) ----------------------------------------------------------------
  const listed: ProviderListedEvent[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let reachedEnd = false;
  let startingAfter: string | undefined;
  const truncated = { pages: false, events: false };
  if (listFromS < endS) {
    for (;;) {
      if (pages >= p.maxPages) { truncated.pages = true; addError('PAGE_LIMIT'); break; }
      let page: { events: ProviderListedEvent[]; hasMore: boolean };
      try {
        page = await withRetry(() => deps.source.list({ createdGte: listFromS, createdLt: endS, types: p.types, limit: p.pageSize, startingAfter }), attempts, backoff, sleep);
      } catch (e) { addError(errCode(e)); break; }
      pages++;
      const valid = Array.isArray(page.events) && page.events.every(x => x && typeof x.id === 'string' && /^evt_[A-Za-z0-9_]+$/.test(x.id) && Number.isInteger(x.created));
      if (!valid || (page.hasMore && page.events.length === 0)) { addError('INVALID_PAGE'); break; }
      for (const ev of page.events) if (!seen.has(ev.id)) { seen.add(ev.id); listed.push(ev); }
      if (listed.length > p.maxEvents) { truncated.events = true; addError('EVENT_LIMIT'); break; }
      if (!page.hasMore) { reachedEnd = true; break; }
      startingAfter = page.events[page.events.length - 1]!.id;
    }
  } else {
    reachedEnd = true; // nothing recoverable to list; the clipped part is recorded below
  }

  // ---- compare with local evidence; retrieve and ingest what is absent --------------------------------
  const ucw = dry ? [] : deriveUcw(await loadStreamEvents(deps.db, stream, t0), stream, t0);
  let present = 0, absent = 0, ingested = 0, replayed = 0;
  const considered = truncated.events ? listed.slice(0, p.maxEvents) : listed;
  for (const ev of considered) {
    const local = (await deps.db.select({ id: stripeProviderEvents.id }).from(stripeProviderEvents).where(and(
      eq(stripeProviderEvents.receivingAccountId, deps.receivingAccountId), eq(stripeProviderEvents.eventAccountId, deps.receivingAccountId),
      eq(stripeProviderEvents.livemode, deps.livemode), eq(stripeProviderEvents.stripeEventId, ev.id),
    )).limit(1))[0];
    if (local) {
      present++;
      if (!dry) await deps.store.annotateOnce(local.id, 'reconciliation_confirmed', ['RECONCILED']);
      continue;
    }
    absent++;
    if (dry) continue;
    let got: { rawBody: string; apiVersion: string | null };
    try { got = await withRetry(() => deps.source.retrieve(ev.id), attempts, backoff, sleep); } catch (e) { addError(`RETRIEVE_${errCode(e)}`, ev.id); continue; }
    const shape = classifyEnvelope(got.rawBody);
    if (shape.kind !== 'ok' || shape.envelope.id !== ev.id || shape.envelope.livemode !== deps.livemode) {
      // A retrieved body that cannot be stored as a well-formed envelope of the expected identity makes the run incomplete.
      addError('RETRIEVE_UNSTORABLE', ev.id);
      continue;
    }
    const cap = await deps.store.captureRetrieved({
      rawBody: new TextEncoder().encode(got.rawBody), envelope: shape.envelope, retrievedAt: now(), retrievalRunId: startedEventId!, retrievalApiVersion: got.apiVersion,
      receivedAt: now(), attestationEventId: att.id, retention: deps.retention,
    });
    if (cap.outcome === 'captured') {
      ingested++;
      // Rows whose event time lies inside an uncertified window are candidate evidence only; the window stays uncertified (E.4).
      if (coverageStateAt(ucw, new Date(shape.envelope.created * 1000), t0) === 'UNCERTIFIED') await deps.store.annotateOnce(cap.eventRecordId, 'recovered_during_uncertified_window', ['RECONCILIATION']);
    } else if (cap.outcome === 'replay') replayed++;
    else addError('PROVIDER_FIELD_MISMATCH', ev.id);
  }

  // ---- outcome ------------------------------------------------------------------------------------------
  const complete = reachedEnd && errors.length === 0;
  const state: ReconcileState = dry ? 'dry_run' : clippedBefore !== null ? 'unrecovered_gap' : complete ? 'reconciled_no_known_gaps' : 'incomplete';
  const result: ReconcileResult = {
    state, runId, startedEventId, pages, listed: listed.length, presentLocally: present, absent, ingested, replayed, errors, truncated,
    listedIdsDigest: digest(listed.map(x => x.id)), statement: NO_COMPLETENESS_CLAIM,
  };
  if (dry) return result;

  await control.append({
    kind: 'reconciliation_run', actor: deps.actor, stream, commitSha: deps.commitSha ?? undefined, dedupeKey: `recon:${stream}:${runId}`, windowStart: p.windowStart, windowEnd: p.windowEnd,
    details: {
      state, runId, startedEventId, ruleVersion: RECONCILE_RULE, pageSize: p.pageSize, maxPages: p.maxPages, maxEvents: p.maxEvents, types: p.types ?? null,
      retrievalCutoff: new Date(horizonStartS * 1000).toISOString(), retrievalHorizonSeconds: horizonSec, pages, listed: listed.length, listedIdsDigest: result.listedIdsDigest,
      presentLocally: present, absent, ingested, replayed, errorCount: errors.length, errors, truncated, reachedEnd, statement: NO_COMPLETENESS_CLAIM,
    },
  });
  if (state === 'incomplete') {
    await control.append({ kind: 'coverage_gap_unrecovered', actor: deps.actor, stream, dedupeKey: `gap-unrec:${stream}:${runId}`, windowStart: p.windowStart, windowEnd: p.windowEnd, details: { cause: 'reconciliation_incomplete', runId } });
  }
  if (clippedBefore !== null) {
    await control.append({ kind: 'coverage_gap_unrecovered', actor: deps.actor, stream, dedupeKey: `gap-unrec-old:${stream}:${runId}`, windowStart: p.windowStart, windowEnd: new Date(clippedBefore * 1000), details: { cause: 'reconciliation_incomplete', runId, reason: 'older_than_retrieval_window' } });
    if (!complete) await control.append({ kind: 'coverage_gap_unrecovered', actor: deps.actor, stream, dedupeKey: `gap-unrec:${stream}:${runId}`, windowStart: new Date(clippedBefore * 1000), windowEnd: p.windowEnd, details: { cause: 'reconciliation_incomplete', runId } });
  }
  return result;
}

async function findControlId(db: Database, dedupeKey: string): Promise<string> {
  const c = stripeEvidenceControlEvents;
  const r = await db.select({ id: c.id }).from(c).where(eq(c.dedupeKey, dedupeKey)).limit(1);
  if (!r[0]) throw new Error('control event not found after insert');
  return r[0].id;
}

/**
 * Real provider source: plain fetch under the restricted read-only key, so the retrieve path keeps the EXACT response bytes
 * (the SDK would re-serialize). The key is only ever placed in the Authorization header; errors carry the status only.
 */
export function stripeFetchSource(restrictedKey: string, fetchImpl: typeof fetch = fetch, base = 'https://api.stripe.com'): ProviderEventSource {
  const get = async (path: string) => {
    const res = await fetchImpl(base + path, { headers: { Authorization: `Bearer ${restrictedKey}`, Accept: 'application/json' } });
    if (!res.ok) throw new ProviderHttpError(res.status);
    return res;
  };
  return {
    async list(p) {
      const q = new URLSearchParams({ limit: String(p.limit), 'created[gte]': String(p.createdGte), 'created[lt]': String(p.createdLt) });
      if (p.startingAfter) q.set('starting_after', p.startingAfter);
      for (const t of p.types ?? []) q.append('types[]', t);
      const body = (await (await get(`/v1/events?${q.toString()}`)).json()) as { object?: string; data?: unknown; has_more?: unknown };
      if (body.object !== 'list' || !Array.isArray(body.data) || typeof body.has_more !== 'boolean') throw new InvalidProviderPage();
      return { events: (body.data as { id: string; type: string; created: number }[]).map(e => ({ id: e.id, type: e.type, created: e.created })), hasMore: body.has_more };
    },
    async retrieve(id) {
      const res = await get(`/v1/events/${encodeURIComponent(id)}`);
      return { rawBody: await res.text(), apiVersion: res.headers.get('stripe-version') };
    },
  };
}
