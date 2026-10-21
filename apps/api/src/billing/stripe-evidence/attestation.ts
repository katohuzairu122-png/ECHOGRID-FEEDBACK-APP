import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type { Database } from '../../db/client';
import { ControlEventWriter, streamOf } from './control-events';

/**
 * HETA-01-F1 B.2: L2 account/endpoint attestation. DEPLOY-TIME / OPERATOR code only; never imported by the Worker
 * request path. Uses a RESTRICTED READ-ONLY Stripe key (custody outside the Worker, H1), never the runtime key.
 * Every attempt is appended as `account_provenance_verified` with result passed|failed; details carry no key and
 * nothing key-derived. Pure evaluation is separated from I/O so every failure mode is unit-tested without Stripe.
 *
 * Open facts (P20, [U]): how the webhook-endpoint object exposes direct versus Connect scope must be confirmed in
 * Stripe test mode. This implementation fails closed only on POSITIVE Connect evidence (`application` set) and records
 * the basis it used, so the owner's residual-risk acceptance is explicit in the control event.
 */
export const ATTESTATION_VERIFIER = 'heta01-f1-l2/1';
export const DEFAULT_REQUIRED_EVENT_TYPES = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'] as const;
export const MAX_ENDPOINT_PAGES = 20;

export interface AttestationExpectation {
  accountId: string;
  livemode: boolean;
  /** This environment's exact webhook URL: scheme, host, path; no query, fragment or userinfo. */
  endpointUrl: string;
  /** Owner-approved endpoint API versions (H2). */
  approvedApiVersions: readonly string[];
  requiredEventTypes: readonly string[];
}

export interface ObservedEndpoint {
  id: string;
  url: string;
  status: string;
  livemode: boolean;
  apiVersion: string | null;
  enabledEvents: readonly string[];
  /** Connect application id when Stripe reports one; null for a plain account endpoint. */
  application: string | null;
}

export interface AttestationObservation {
  accountId: string | null;
  /** Mode implied by the key prefix, null when unrecognizable. */
  keyLivemode: boolean | null;
  restrictedKey: boolean;
  listing: { complete: boolean; pages: number; endpoints: readonly ObservedEndpoint[] } | null;
  apiError?: string;
}

export type AttestationFailure =
  | 'EXPECTATION_INVALID' | 'RESTRICTED_KEY_REQUIRED' | 'STRIPE_API_ERROR' | 'ACCOUNT_MISMATCH' | 'KEY_MODE_UNKNOWN' | 'KEY_MODE_MISMATCH'
  | 'LISTING_INCOMPLETE' | 'ENDPOINT_NOT_FOUND' | 'ENDPOINT_AMBIGUOUS' | 'ENDPOINT_DISABLED' | 'ENDPOINT_MODE_MISMATCH'
  | 'API_VERSION_UNAPPROVED' | 'EVENTS_NOT_SUPERSET' | 'ENDPOINT_NOT_DIRECT';

export interface AttestationOutcome {
  result: 'passed' | 'failed';
  failures: AttestationFailure[];
  /** Non-secret facts recorded in the control event. */
  details: Record<string, unknown>;
}

const ACCT_RE = /^acct_[A-Za-z0-9]+$/;

/** Exact-URL identity: same origin and path, and neither side carries query, fragment or userinfo. */
export function sameEndpointUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    for (const u of [x, y]) if (u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return false;
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

export const eventsDigest = (events: readonly string[]) => createHash('sha256').update(JSON.stringify([...events].sort())).digest('hex');

export function keyModeOf(key: string): boolean | null {
  if (/^(rk|sk)_live_/.test(key)) return true;
  if (/^(rk|sk)_test_/.test(key)) return false;
  return null;
}
export const isRestrictedKey = (key: string) => key.startsWith('rk_');

export function evaluateAttestation(exp: AttestationExpectation, obs: AttestationObservation, ctx: { commitSha: string | null; checkedAt: Date; verifier?: string }): AttestationOutcome {
  const failures: AttestationFailure[] = [];
  const base: Record<string, unknown> = {
    result: 'failed', verifier: ctx.verifier ?? ATTESTATION_VERIFIER, checkedAt: ctx.checkedAt.toISOString(), commitSha: ctx.commitSha,
    expectedAccountId: exp.accountId, expectedLivemode: exp.livemode, expectedUrl: exp.endpointUrl,
  };
  const fail = (...f: AttestationFailure[]) => { for (const x of f) if (!failures.includes(x)) failures.push(x); };

  let urlOk = false;
  try { const u = new URL(exp.endpointUrl); urlOk = u.search === '' && u.hash === '' && u.username === '' && u.pathname !== '' && (u.protocol === 'https:' || u.hostname === 'localhost'); } catch { /* invalid */ }
  if (!ACCT_RE.test(exp.accountId) || !urlOk || exp.approvedApiVersions.length === 0 || exp.requiredEventTypes.length === 0) fail('EXPECTATION_INVALID');
  if (!obs.restrictedKey) fail('RESTRICTED_KEY_REQUIRED');
  if (obs.apiError !== undefined) fail('STRIPE_API_ERROR');
  if (obs.accountId !== null && obs.accountId !== exp.accountId) fail('ACCOUNT_MISMATCH');
  if (obs.accountId === null && obs.apiError === undefined) fail('ACCOUNT_MISMATCH');
  if (obs.keyLivemode === null) fail('KEY_MODE_UNKNOWN');
  else if (obs.keyLivemode !== exp.livemode) fail('KEY_MODE_MISMATCH');

  const details: Record<string, unknown> = { ...base, observedAccountId: obs.accountId, keyLivemode: obs.keyLivemode, apiError: obs.apiError ?? null };
  if (obs.listing) {
    details.listing = { pages: obs.listing.pages, complete: obs.listing.complete, endpointsSeen: obs.listing.endpoints.length };
    if (!obs.listing.complete) fail('LISTING_INCOMPLETE');
    const matches = obs.listing.endpoints.filter(e => sameEndpointUrl(e.url, exp.endpointUrl));
    if (matches.length === 0) fail('ENDPOINT_NOT_FOUND');
    if (matches.length > 1) fail('ENDPOINT_AMBIGUOUS');
    const ep = matches.length === 1 ? matches[0]! : null;
    if (ep) {
      Object.assign(details, {
        endpointId: ep.id, endpointUrl: ep.url, endpointStatus: ep.status, endpointLivemode: ep.livemode, apiVersion: ep.apiVersion,
        enabledEventsDigest: eventsDigest(ep.enabledEvents), enabledEventsCount: ep.enabledEvents.length,
        directScopeBasis: ep.application === null ? 'endpoint.application is null (P20: not independently confirmed)' : 'endpoint.application set',
      });
      if (ep.status !== 'enabled') fail('ENDPOINT_DISABLED');
      if (ep.livemode !== exp.livemode) fail('ENDPOINT_MODE_MISMATCH');
      if (ep.apiVersion === null || !exp.approvedApiVersions.includes(ep.apiVersion)) fail('API_VERSION_UNAPPROVED');
      const enabled = new Set(ep.enabledEvents);
      if (!enabled.has('*') && !exp.requiredEventTypes.every(t => enabled.has(t))) fail('EVENTS_NOT_SUPERSET');
      if (ep.application !== null) fail('ENDPOINT_NOT_DIRECT');
    }
  } else if (obs.apiError === undefined) {
    fail('LISTING_INCOMPLETE');
  }
  details.failures = failures;
  details.result = failures.length === 0 ? 'passed' : 'failed';
  return { result: failures.length === 0 ? 'passed' : 'failed', failures, details };
}

export interface RunAttestationOptions {
  db: Database;
  observe: () => Promise<AttestationObservation>;
  expectation: AttestationExpectation;
  commitSha: string | null;
  actor: string;
  now?: () => Date;
  dryRun?: boolean;
}

/** Observes, evaluates, and (unless dryRun) appends the attempt. A failed attempt is recorded too, and supersedes an earlier pass. */
export async function runAttestation(o: RunAttestationOptions): Promise<AttestationOutcome & { recorded: boolean; stream: string }> {
  const now = o.now ?? (() => new Date());
  let obs: AttestationObservation;
  try {
    obs = await o.observe();
  } catch (e) {
    obs = { accountId: null, keyLivemode: null, restrictedKey: true, listing: null, apiError: e instanceof Error ? e.name : 'Error' };
  }
  const outcome = evaluateAttestation(o.expectation, obs, { commitSha: o.commitSha, checkedAt: now() });
  const stream = streamOf(o.expectation.accountId, o.expectation.livemode);
  if (o.dryRun) return { ...outcome, recorded: false, stream };
  const recorded = await new ControlEventWriter(o.db).append({ kind: 'account_provenance_verified', actor: o.actor, stream, commitSha: o.commitSha ?? undefined, details: outcome.details });
  return { ...outcome, recorded, stream };
}

/** Real Stripe observation under a restricted read-only key. Never logs or returns the key. Not exercised against Stripe in CI. */
export function stripeObserver(restrictedKey: string): () => Promise<AttestationObservation> {
  return async () => {
    const restricted = isRestrictedKey(restrictedKey);
    const keyLivemode = keyModeOf(restrictedKey);
    if (!restricted) return { accountId: null, keyLivemode, restrictedKey: false, listing: null };
    const stripe = new Stripe(restrictedKey, { maxNetworkRetries: 2 });
    try {
      const account = await stripe.accounts.retrieveCurrent();
      const endpoints: ObservedEndpoint[] = [];
      let pages = 0;
      let complete = false;
      let startingAfter: string | undefined;
      while (pages < MAX_ENDPOINT_PAGES) {
        const page = await stripe.webhookEndpoints.list({ limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
        pages++;
        for (const w of page.data) {
          endpoints.push({
            id: w.id, url: w.url, status: w.status, livemode: w.livemode, apiVersion: w.api_version ?? null, enabledEvents: w.enabled_events,
            application: (w as unknown as { application?: string | null }).application ?? null,
          });
        }
        if (!page.has_more) { complete = true; break; }
        startingAfter = page.data[page.data.length - 1]?.id;
        if (!startingAfter) break;
      }
      return { accountId: account.id, keyLivemode, restrictedKey: true, listing: { complete, pages, endpoints } };
    } catch (e) {
      return { accountId: null, keyLivemode, restrictedKey: true, listing: null, apiError: e instanceof Error ? e.name : 'Error' };
    }
  };
}
