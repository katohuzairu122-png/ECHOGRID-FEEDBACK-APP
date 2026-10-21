import type Stripe from 'stripe';
import type { Database } from '../../db/client';
import { StripeEvidenceStore } from './evidence.store';
import { ControlEventWriter, streamOf, type BucketKind } from './control-events';
import { checkKeyring, maxBodyBytes, resolveConfig, type CaptureEnv, type PreconditionCode } from './capture.config';
import { classifyEnvelope } from './shape';
import { verifyWebhookSignature } from './signature';

/**
 * HETA-01-F1 G.2: the enforced capture pipeline. Used by the webhook route ONLY when STRIPE_EVIDENCE_CAPTURE
 * is not `off`; with `off` the route runs today's code unchanged.
 *
 * receive -> size (413) -> verify signature over the raw body (400) -> Class S (503) -> shape ->
 * Tx1 capture -> Tx2 claim -> classification annotations -> legacy projection (unchanged) -> Tx3 outcome.
 *
 * Capture or legacy failures are RETHROWN so the existing global error handler returns the same 500 as today
 * (Stripe retries). The handler never touches the three fail-closed authority flags.
 */
export const SUBSCRIPTION_EVENT_TYPES = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);

export type HandlerResult =
  | { status: 200; body: { received: true; capture: 'captured' | 'replay' | 'conflict' | 'malformed' | 'complete' | 'processed' } }
  | { status: 400; body: { error: 'MISSING_SIGNATURE' | 'INVALID_SIGNATURE' } }
  | { status: 409; body: { error: 'PROCESSING_IN_PROGRESS' } }
  | { status: 413; body: { error: 'PAYLOAD_TOO_LARGE' } }
  | { status: 503; body: { error: 'CAPTURE_PRECONDITION_FAILED' } };

export interface HandlerInput {
  rawBody: string;
  signatureHeader: string | null | undefined;
  /** Declared Content-Length, when present (checked by the route before the body is read, and again here on the bytes). */
  contentLength: number | null;
  env: CaptureEnv;
  openDb: () => Promise<{ db: Database; close: () => Promise<void> }>;
  /** Today's projection, unchanged: StripeWebhookService.processEvent then the 0043 recorder. */
  runLegacy: (event: Stripe.Event, db: Database) => Promise<void>;
  now?: () => Date;
  claimantId?: string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const enc = new TextEncoder();

/** Best-effort control-event write; the evidence itself is never blocked by a bucket failure. */
async function safely(log: HandlerInput['log'], what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    log?.('stripe evidence control event not recorded', { what });
  }
}

export async function handleEnforcedCapture(input: HandlerInput): Promise<HandlerResult> {
  const now = input.now ?? (() => new Date());
  const log = input.log;
  const env = input.env;
  const cfgResult = resolveConfig(env);
  const stream = streamOf(env.STRIPE_ACCOUNT_ID && /^acct_[A-Za-z0-9]+$/.test(env.STRIPE_ACCOUNT_ID) ? env.STRIPE_ACCOUNT_ID : 'unconfigured', env.STRIPE_EXPECTED_LIVEMODE === 'true' || env.STRIPE_EXPECTED_LIVEMODE === 'false' ? env.STRIPE_EXPECTED_LIVEMODE : 'unknown');

  const bucketOnce = async (kind: BucketKind, details: Record<string, unknown>) => {
    let conn: Awaited<ReturnType<HandlerInput['openDb']>> | null = null;
    await safely(log, kind, async () => {
      conn = await input.openDb();
      await new ControlEventWriter(conn.db).bucket(kind, stream, now(), details);
    });
    if (conn) await safely(log, 'close', () => (conn as unknown as { close: () => Promise<void> }).close());
  };

  // Class P: size. Nothing unauthenticated is stored beyond a bounded hint bucket (D.2).
  const bytes = enc.encode(input.rawBody);
  const cap = maxBodyBytes(env);
  if ((input.contentLength !== null && input.contentLength > cap) || bytes.length > cap) {
    await bucketOnce('oversize_rejected', {
      contentLength: input.contentLength ?? bytes.length, cap, signatureHeaderPresent: Boolean(input.signatureHeader),
      unauthenticatedTimestampHint: /(?:^|,)\s*t=([0-9]{1,12})/.exec(input.signatureHeader ?? '')?.[1] ?? null,
    });
    return { status: 413, body: { error: 'PAYLOAD_TOO_LARGE' } };
  }

  // Class P: authenticate over the exact raw body. Parse failures are NOT signature failures. No database use before this passes.
  if (!input.signatureHeader) return { status: 400, body: { error: 'MISSING_SIGNATURE' } };
  const secrets = cfgResult.ok ? cfgResult.cfg.secrets : [
    ...(env.STRIPE_WEBHOOK_SECRET ? [{ label: 'primary', secret: env.STRIPE_WEBHOOK_SECRET }] : []),
    ...(env.STRIPE_WEBHOOK_SECRET_PREVIOUS ? [{ label: 'previous', secret: env.STRIPE_WEBHOOK_SECRET_PREVIOUS }] : []),
  ];
  const sig = await verifyWebhookSignature({ rawBody: input.rawBody, header: input.signatureHeader, secrets, now: now() });
  if (!sig.ok) {
    log?.('stripe webhook signature verification failed', { reason: sig.reason });
    return { status: 400, body: { error: 'INVALID_SIGNATURE' } };
  }

  // Class S: system preconditions. Failure -> 503, nothing stored, one bucket per minute.
  const failures: PreconditionCode[] = cfgResult.ok ? [] : [...cfgResult.failures];
  const keyring = await checkKeyring(env, now());
  if (!keyring.ok) failures.push(keyring.code);
  if (!cfgResult.ok || !keyring.ok) {
    await bucketOnce('capture_precondition_failed', { failed: failures, ...(keyring.ok ? {} : { keyring: keyring.detail }) });
    return { status: 503, body: { error: 'CAPTURE_PRECONDITION_FAILED' } };
  }
  const cfg = cfgResult.cfg;

  let conn: Awaited<ReturnType<HandlerInput['openDb']>>;
  try {
    conn = await input.openDb();
  } catch {
    return { status: 503, body: { error: 'CAPTURE_PRECONDITION_FAILED' } }; // cannot be recorded; covered by the heartbeat gap (E.2)
  }
  const { db, close } = conn;
  try {
    const control = new ControlEventWriter(db);
    const attestation = await control.latestAttestation(stream);
    if (!attestation || !attestation.passed || now().getTime() - attestation.occurredAt.getTime() > cfg.l2MaxAgeSeconds * 1000) {
      await safely(log, 'capture_precondition_failed', () => control.bucket('capture_precondition_failed', stream, now(), { failed: ['ATTESTATION_NOT_CURRENT'] }));
      return { status: 503, body: { error: 'CAPTURE_PRECONDITION_FAILED' } };
    }

    const store = new StripeEvidenceStore(db, { receivingAccountId: cfg.receivingAccountId, keyring: keyring.keyring, now });
    const receivedAt = now();
    const retention = { policyVersion: cfg.retention.policyVersion, retainUntil: new Date(receivedAt.getTime() + cfg.retention.days * 86_400_000) };
    const shape = classifyEnvelope(input.rawBody);

    try {
      if (shape.kind === 'malformed') {
        await store.captureMalformed({ rawBody: bytes, parseStatus: shape.parseStatus, defects: shape.defects, signature: sig.provenance, receivedAt, attestationEventId: attestation.id, retention });
        return { status: 200, body: { received: true, capture: 'malformed' } };
      }

      const captured = await store.captureWellFormed({ rawBody: bytes, envelope: shape.envelope, signature: sig.provenance, receivedAt, attestationEventId: attestation.id, retention });
      if (captured.outcome === 'conflict') return { status: 200, body: { received: true, capture: 'conflict' } };

      const claim = await store.claim(captured.eventRecordId, input.claimantId ?? crypto.randomUUID(), cfg.leaseSeconds);
      if (claim.state === 'complete') return { status: 200, body: { received: true, capture: 'complete' } };
      if (claim.state === 'in_progress') return { status: 409, body: { error: 'PROCESSING_IN_PROGRESS' } };

      // Classification: annotations only (idempotent); never attribution, never a completion marker.
      const e = shape.envelope;
      const quarantine: string[] = [];
      if (e.livemode !== cfg.expectedLivemode) quarantine.push('QR_MODE_MISMATCH');
      if (e.account !== null && e.account !== cfg.receivingAccountId) quarantine.push('QR_CONNECT_UNSUPPORTED');
      for (const code of quarantine) await store.annotateOnce(captured.eventRecordId, 'quarantined', [code]);
      const inScope = SUBSCRIPTION_EVENT_TYPES.has(e.type);
      if (!inScope) await store.annotateOnce(captured.eventRecordId, 'out_of_scope_type', ['QR_TYPE_UNSUPPORTED']);
      else if (quarantine.length === 0) await store.annotateOnce(captured.eventRecordId, 'eligible_for_projection', []);

      // Legacy projection exactly as today (H20: runs even for evidence-quarantined events). At-least-once per claim.
      try {
        await input.runLegacy(JSON.parse(input.rawBody) as Stripe.Event, db);
      } catch (err) {
        await safely(log, 'projection_failed', () => store.recordOutcome(captured.eventRecordId, claim.attemptNo, 'projection_failed', { reasonCodes: ['E_LEGACY_PROJECTION'] }));
        throw err; // the global error handler returns today's 500
      }
      await store.recordOutcome(captured.eventRecordId, claim.attemptNo, inScope ? 'projection_applied' : 'projection_skipped');
      return { status: 200, body: { received: true, capture: 'processed' } };
    } catch (err) {
      // Capture failure (or a rethrown legacy failure): record a bounded bucket where possible, then let it surface as a 500.
      await safely(log, 'capture_error_observed', () => control.bucket('capture_error_observed', stream, now(), { error: err instanceof Error ? err.name : 'unknown' }));
      throw err;
    }
  } finally {
    await safely(log, 'close', close);
  }
}
