import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../db/client';
import {
  stripeEvidenceKeys,
  stripeProviderEventConflicts,
  stripeProviderEventDispositions,
  stripeProviderEvents,
  stripeProviderMalformedReceipts,
} from '../../db/schema';
import {
  createWrappedDek, equalBytes, EvidenceCryptoError, sealPayload, sha256, unwrapDek,
  type EnvelopeBinding, type SealedEnvelope,
} from './envelope';
import { cohortOf, EvidenceKeyringError, type LoadedKeyring } from './keyring';
import type { ShapeDefect, ParseStatus, WellFormedEnvelope } from './shape';
import type { SignatureProvenance } from './signature';

/**
 * HETA-01-F1 G.2 steps 5-9: durable capture, claim and outcome logging over the six append-only tables.
 * Not wired into any route; capture stays off. Legacy projection is not invoked here. Every public
 * method is one short READ COMMITTED transaction. Inserts are append-only; nothing here updates or deletes.
 */
export const CAPTURE_RULE_VERSION = 'heta01-f1-capture/1';
export const COMPLETION_MARKERS = ['projection_applied', 'projection_skipped'] as const;
export const OUTCOMES = ['projection_applied', 'projection_skipped', 'projection_failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type Annotation = 'quarantined' | 'out_of_scope_type' | 'eligible_for_projection' | 'provider_corroborated' | 'reconciliation_confirmed' | 'recovered_during_uncertified_window';

export class EvidenceStoreError extends Error {
  constructor(public readonly code: 'KEK_UNAVAILABLE' | 'NO_SUCH_CLAIM' | 'EMPTY_BODY') {
    super(`Evidence store failure: ${code}`);
    this.name = 'EvidenceStoreError';
  }
}

export interface StoreConfig {
  /** Receiving account from configuration (authority). Never read from event content. */
  receivingAccountId: string;
  keyring: LoadedKeyring;
  /** Server clock; injected for tests. Taken once per capture, at the start of the transaction. */
  now?: (() => Date) | undefined;
}

export interface Retention {
  policyVersion: string;
  retainUntil: Date;
}

export interface WellFormedCapture {
  rawBody: Uint8Array;
  envelope: WellFormedEnvelope;
  signature: SignatureProvenance;
  receivedAt: Date;
  /** The passing `account_provenance_verified` control event in force. */
  attestationEventId: string;
  retention: Retention;
}

type ProvenanceInput =
  | { kind: 'webhook_signature'; signature: SignatureProvenance }
  | { kind: 'api_retrieval'; retrievedAt: Date; runId: string; apiVersion: string | null };

interface EnvelopeCapture {
  rawBody: Uint8Array;
  envelope: WellFormedEnvelope;
  receivedAt: Date;
  attestationEventId: string;
  retention: Retention;
  prov: ProvenanceInput;
}

export interface RetrievedCapture {
  /** The exact bytes of the provider's `events.retrieve` response body. */
  rawBody: Uint8Array;
  envelope: WellFormedEnvelope;
  retrievedAt: Date;
  /** The `reconciliation_run` control event that fetched it. */
  retrievalRunId: string;
  retrievalApiVersion: string | null;
  receivedAt: Date;
  attestationEventId: string;
  retention: Retention;
}

export type CaptureResult =
  | { outcome: 'captured'; eventRecordId: string }
  | { outcome: 'replay'; eventRecordId: string }
  | { outcome: 'conflict'; eventRecordId: string; conflictRecorded: boolean };

export interface MalformedCapture {
  rawBody: Uint8Array;
  parseStatus: ParseStatus;
  defects: ShapeDefect[];
  signature: SignatureProvenance;
  receivedAt: Date;
  attestationEventId: string;
  retention: Retention;
}

export type ClaimResult =
  | { state: 'claimed'; attemptNo: number; leaseExpiresAt: Date }
  | { state: 'complete' }
  | { state: 'in_progress' };

const hex = (u: Uint8Array) => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');
const buf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
type Tx = Transaction;

/** Identity string bound into the ciphertext (AAD); reproducible at read time from the row. */
export function eventIdentity(r: { receivingAccountId: string; eventAccountId: string; livemode: boolean; stripeEventId: string; provenance: string }): string {
  return [r.receivingAccountId, r.eventAccountId, String(r.livemode), r.stripeEventId, r.provenance].join('|');
}

export class StripeEvidenceStore {
  private readonly now: () => Date;
  constructor(private readonly db: Database, private readonly cfg: StoreConfig) {
    this.now = cfg.now ?? (() => new Date());
  }

  /**
   * Finds or creates the cohort DEK inside the caller's transaction (C.2/C.3). Race-safe: the unique
   * (cohort, kek_version) constraint makes a concurrent loser discard its candidate DEK and unwrap the winner's.
   */
  private async dekFor(tx: Tx, at: Date): Promise<{ dek: CryptoKey; cohort: string; kekVersion: string }> {
    const cohort = cohortOf(at);
    const rows = await tx.select().from(stripeEvidenceKeys).where(eq(stripeEvidenceKeys.cohort, cohort));
    const usable = await this.unwrapFirst(rows);
    if (usable) return usable;
    if (rows.length > 0) throw new EvidenceStoreError('KEK_UNAVAILABLE'); // the cohort has a DEK but the Worker holds none of its KEKs
    let active;
    try {
      active = this.cfg.keyring.activeFor(at);
    } catch (e) {
      if (e instanceof EvidenceKeyringError) throw new EvidenceStoreError('KEK_UNAVAILABLE');
      throw e;
    }
    const { wrapped, dek } = await createWrappedDek(active.key, cohort, active.kekVersion);
    const inserted = await tx
      .insert(stripeEvidenceKeys)
      .values({
        cohort, kekVersion: active.kekVersion, wrappedDek: buf(wrapped.wrappedDek), wrapNonce: buf(wrapped.wrapNonce),
        wrapAlgorithm: 'AES-256-GCM', dekFingerprint: buf(wrapped.dekFingerprint),
      })
      .onConflictDoNothing({ target: [stripeEvidenceKeys.cohort, stripeEvidenceKeys.kekVersion] })
      .returning({ id: stripeEvidenceKeys.id });
    if (inserted.length > 0) return { dek, cohort, kekVersion: active.kekVersion };
    // Lost the race: discard the candidate DEK and unwrap the winner's row.
    const winner = await tx.select().from(stripeEvidenceKeys).where(and(eq(stripeEvidenceKeys.cohort, cohort), eq(stripeEvidenceKeys.kekVersion, active.kekVersion)));
    const w = await this.unwrapFirst(winner);
    if (!w) throw new EvidenceStoreError('KEK_UNAVAILABLE');
    return w;
  }

  private async unwrapFirst(rows: (typeof stripeEvidenceKeys.$inferSelect)[]) {
    for (const r of rows) {
      const kek = this.cfg.keyring.find(r.cohort, r.kekVersion);
      if (!kek) continue;
      try {
        const dek = await unwrapDek(kek.key, { wrappedDek: r.wrappedDek, wrapNonce: r.wrapNonce, dekFingerprint: r.dekFingerprint }, r.cohort, r.kekVersion);
        return { dek, cohort: r.cohort, kekVersion: r.kekVersion };
      } catch (e) {
        // A KEK that is present by label but cannot unwrap this row (wrong bytes, corrupted row) is simply not usable for it;
        // the caller fails closed with KEK_UNAVAILABLE if no other wrapped row of the cohort unwraps.
        if (!(e instanceof EvidenceCryptoError)) throw e;
      }
    }
    return null;
  }

  private seal(dek: CryptoKey, body: Uint8Array, b: EnvelopeBinding): Promise<SealedEnvelope> {
    if (body.length === 0) throw new EvidenceStoreError('EMPTY_BODY');
    return sealPayload(dek, body, b);
  }

  /** Tx1 for a well-formed envelope (G.2 step 5). Replays are idempotent; a different body under the same identity is a recorded conflict. */
  captureWellFormed(c: WellFormedCapture): Promise<CaptureResult> {
    return this.captureEnvelope({ ...c, prov: { kind: 'webhook_signature', signature: c.signature } });
  }

  /**
   * Reconciliation ingest (D.3): the exact bytes of a provider `events.retrieve` response, stored as `api_retrieval`
   * provenance with `retrieval_run_id`. Never presented as webhook-signature evidence (the database CHECK enforces it).
   */
  captureRetrieved(c: RetrievedCapture): Promise<CaptureResult> {
    return this.captureEnvelope({ ...c, prov: { kind: 'api_retrieval', retrievedAt: c.retrievedAt, runId: c.retrievalRunId, apiVersion: c.retrievalApiVersion } });
  }

  private async captureEnvelope(c: EnvelopeCapture): Promise<CaptureResult> {
    if (c.rawBody.length === 0) throw new EvidenceStoreError('EMPTY_BODY');
    const at = this.now();
    const e = c.envelope;
    const p = c.prov;
    const eventAccountId = e.account ?? this.cfg.receivingAccountId;
    const identity = {
      receivingAccountId: this.cfg.receivingAccountId, eventAccountId, livemode: e.livemode, stripeEventId: e.id, provenance: p.kind,
    };
    const actor = p.kind === 'webhook_signature' ? 'webhook' : 'reconciliation';
    return this.db.transaction(async tx => {
      const { dek, cohort, kekVersion } = await this.dekFor(tx, at);
      const sealed = await this.seal(dek, c.rawBody, { table: 'stripe_provider_events', identity: eventIdentity(identity), cohort, kekVersion });
      const dataObject = e.dataObject;
      const str = (k: string) => (typeof dataObject[k] === 'string' ? (dataObject[k] as string) : null);
      const customerRaw = dataObject.customer;
      const sig = p.kind === 'webhook_signature'
        ? { sigHeaderTimestamp: p.signature.headerTimestamp, sigScheme: p.signature.scheme, signingSecretLabel: p.signature.secretLabel, verifiedAt: p.signature.verifiedAt, verifierVersion: p.signature.verifierVersion }
        : {};
      const retrieval = p.kind === 'api_retrieval'
        ? { retrievedAt: p.retrievedAt, retrievalRunId: p.runId, retrievalApiVersion: p.apiVersion ?? 'unspecified' }
        : {};
      const inserted = await tx
        .insert(stripeProviderEvents)
        .values({
          ...identity,
          accountScope: eventAccountId === this.cfg.receivingAccountId ? 'direct' : 'connect',
          attestationEventId: c.attestationEventId,
          eventType: e.type,
          apiVersion: e.apiVersion,
          providerCreatedUnix: e.created,
          providerCreatedAt: new Date(e.created * 1000),
          receivedAt: c.receivedAt,
          payloadSha256: buf(sealed.payloadSha256),
          payloadCiphertext: buf(sealed.ciphertext),
          payloadNonce: buf(sealed.nonce),
          payloadKeyCohort: cohort,
          kekVersion,
          payloadBytes: sealed.payloadBytes,
          ...sig,
          ...retrieval,
          stripeRequestId: e.requestId,
          stripeIdempotencyKey: e.idempotencyKey,
          // Advisory claims only (plaintext, never authority); attribution requires F2's verified binding.
          objectType: str('object'),
          stripeSubscriptionId: str('object') === 'subscription' ? str('id') : str('subscription'),
          stripeCustomerId: typeof customerRaw === 'string' ? customerRaw : null,
          captureMode: 'enforced',
          projectionMode: 'legacy',
          retentionPolicyVersion: c.retention.policyVersion,
          retainUntil: c.retention.retainUntil,
        })
        .onConflictDoNothing({
          target: [stripeProviderEvents.receivingAccountId, stripeProviderEvents.eventAccountId, stripeProviderEvents.livemode, stripeProviderEvents.stripeEventId, stripeProviderEvents.provenance],
        })
        .returning({ id: stripeProviderEvents.id });
      if (inserted[0]) {
        await tx.insert(stripeProviderEventDispositions).values({
          eventRecordId: inserted[0].id, disposition: 'capture_committed', actor, ruleVersion: CAPTURE_RULE_VERSION,
          reasonCodes: p.kind === 'api_retrieval' ? ['API_RETRIEVAL'] : [],
        });
        return { outcome: 'captured', eventRecordId: inserted[0].id } as const;
      }
      const existing = (
        await tx
          .select({ id: stripeProviderEvents.id, digest: stripeProviderEvents.payloadSha256 })
          .from(stripeProviderEvents)
          .where(and(
            eq(stripeProviderEvents.receivingAccountId, identity.receivingAccountId), eq(stripeProviderEvents.eventAccountId, identity.eventAccountId),
            eq(stripeProviderEvents.livemode, identity.livemode), eq(stripeProviderEvents.stripeEventId, identity.stripeEventId), eq(stripeProviderEvents.provenance, identity.provenance),
          ))
      )[0];
      if (!existing) throw new Error('evidence row vanished after conflict'); // unreachable: rows are append-only
      if (equalBytes(new Uint8Array(existing.digest), sealed.payloadSha256)) return { outcome: 'replay', eventRecordId: existing.id } as const;

      // Same identity and provenance, different body: keep the conflicting body as its own sealed evidence (idempotent by digest).
      const kind = p.kind === 'webhook_signature' ? 'webhook_digest_mismatch' : 'provider_field_mismatch';
      const reason = p.kind === 'webhook_signature' ? 'QR_DIGEST_CONFLICT' : 'QR_PROVIDER_FIELD_MISMATCH';
      const conflictSealed = await this.seal(dek, c.rawBody, {
        table: 'stripe_provider_event_conflicts', identity: `${existing.id}|${kind}|${hex(sealed.payloadSha256)}`, cohort, kekVersion,
      });
      const conflict = await tx
        .insert(stripeProviderEventConflicts)
        .values({
          eventRecordId: existing.id, conflictKind: kind, conflictingProvenance: p.kind,
          conflictingSha256: buf(sealed.payloadSha256), payloadCiphertext: buf(conflictSealed.ciphertext), payloadNonce: buf(conflictSealed.nonce),
          payloadKeyCohort: cohort, kekVersion,
          ...(p.kind === 'webhook_signature'
            ? { sigHeaderTimestamp: p.signature.headerTimestamp, sigScheme: p.signature.scheme, signingSecretLabel: p.signature.secretLabel, verifiedAt: p.signature.verifiedAt, verifierVersion: p.signature.verifierVersion }
            : { retrievedAt: p.retrievedAt, retrievalRunId: p.runId, retrievalApiVersion: p.apiVersion ?? 'unspecified' }),
        })
        .onConflictDoNothing({ target: [stripeProviderEventConflicts.eventRecordId, stripeProviderEventConflicts.conflictKind, stripeProviderEventConflicts.conflictingSha256] })
        .returning({ id: stripeProviderEventConflicts.id });
      if (conflict.length > 0) {
        await tx.insert(stripeProviderEventDispositions).values({
          eventRecordId: existing.id, disposition: 'quarantined', reasonCodes: [reason], actor, ruleVersion: CAPTURE_RULE_VERSION,
          detail: { conflictingSha256: hex(sealed.payloadSha256) },
        });
      }
      return { outcome: 'conflict', eventRecordId: existing.id, conflictRecorded: conflict.length > 0 } as const;
    });
  }

  /** Tx1 for an authenticated body that is not a well-formed envelope (A.2b). The row is its own terminal quarantine record. */
  async captureMalformed(c: MalformedCapture): Promise<{ outcome: 'captured' | 'replay'; receiptId: string }> {
    if (c.rawBody.length === 0) throw new EvidenceStoreError('EMPTY_BODY');
    const at = this.now();
    return this.db.transaction(async tx => {
      const { dek, cohort, kekVersion } = await this.dekFor(tx, at);
      const digestFirst = await sha256(c.rawBody);
      const sealed = await this.seal(dek, c.rawBody, { table: 'stripe_provider_malformed_receipts', identity: hex(digestFirst), cohort, kekVersion });
      const inserted = await tx
        .insert(stripeProviderMalformedReceipts)
        .values({
          receivedAt: c.receivedAt, payloadSha256: buf(sealed.payloadSha256), payloadCiphertext: buf(sealed.ciphertext), payloadNonce: buf(sealed.nonce),
          payloadKeyCohort: cohort, kekVersion, payloadBytes: sealed.payloadBytes,
          sigHeaderTimestamp: c.signature.headerTimestamp, sigScheme: c.signature.scheme, signingSecretLabel: c.signature.secretLabel,
          verifiedAt: c.signature.verifiedAt, verifierVersion: c.signature.verifierVersion,
          parseStatus: c.parseStatus, shapeDefects: c.defects, reasonCodes: ['QR_SHAPE_INVALID'],
          receivingAccountId: this.cfg.receivingAccountId, attestationEventId: c.attestationEventId,
          captureMode: 'enforced', projectionMode: 'legacy', retentionPolicyVersion: c.retention.policyVersion, retainUntil: c.retention.retainUntil,
        })
        .onConflictDoNothing({ target: [stripeProviderMalformedReceipts.payloadSha256] })
        .returning({ id: stripeProviderMalformedReceipts.id });
      if (inserted[0]) return { outcome: 'captured', receiptId: inserted[0].id } as const;
      const existing = await tx.select({ id: stripeProviderMalformedReceipts.id }).from(stripeProviderMalformedReceipts).where(eq(stripeProviderMalformedReceipts.payloadSha256, buf(sealed.payloadSha256)));
      return { outcome: 'replay', receiptId: existing[0]!.id } as const;
    });
  }

  /**
   * Tx2 (G.2 step 6): serialize claim decisions per event with a transaction-scoped advisory lock, then
   * evaluate (i) completion marker -> complete, (ii) unexpired claim without an outcome -> in_progress,
   * (iii) otherwise insert attempt n + 1 with a database-clock lease. The partial unique index is the backstop.
   */
  async claim(eventRecordId: string, claimant: string, leaseSeconds: number): Promise<ClaimResult> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'stripe_evidence_claim:' + eventRecordId}, 0))`);
      const d = stripeProviderEventDispositions;
      const done = await tx.select({ id: d.id }).from(d).where(and(eq(d.eventRecordId, eventRecordId), inArray(d.disposition, [...COMPLETION_MARKERS]))).limit(1);
      if (done.length > 0) return { state: 'complete' } as const;

      const claims = await tx.select({ attemptNo: d.attemptNo, expired: sql<boolean>`${d.leaseExpiresAt} <= clock_timestamp()` })
        .from(d).where(and(eq(d.eventRecordId, eventRecordId), eq(d.disposition, 'processing_claimed'))).orderBy(desc(d.attemptNo));
      const closed = new Set(
        (await tx.select({ attemptNo: d.attemptNo }).from(d).where(and(eq(d.eventRecordId, eventRecordId), inArray(d.disposition, [...OUTCOMES])))).map(r => r.attemptNo),
      );
      if (claims.some(c => !c.expired && !closed.has(c.attemptNo))) return { state: 'in_progress' } as const;

      const attemptNo = (claims[0]?.attemptNo ?? 0) + 1;
      const row = await tx.insert(d).values({
        eventRecordId, disposition: 'processing_claimed', actor: 'webhook', ruleVersion: CAPTURE_RULE_VERSION, attemptNo, claimant,
        leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`,
      }).returning({ lease: d.leaseExpiresAt });
      return { state: 'claimed', attemptNo, leaseExpiresAt: row[0]!.lease! } as const;
    });
  }

  /** Tx3 (G.2 step 9): append the outcome for a claimed attempt. Applied/skipped are completion markers; failed is non-completing. */
  async recordOutcome(eventRecordId: string, attemptNo: number, outcome: Outcome, detail?: { reasonCodes?: string[]; info?: Record<string, unknown> }): Promise<void> {
    await this.db.transaction(async tx => {
      const d = stripeProviderEventDispositions;
      const claimed = await tx.select({ id: d.id }).from(d).where(and(eq(d.eventRecordId, eventRecordId), eq(d.disposition, 'processing_claimed'), eq(d.attemptNo, attemptNo))).limit(1);
      if (claimed.length === 0) throw new EvidenceStoreError('NO_SUCH_CLAIM');
      await tx.insert(d).values({
        eventRecordId, disposition: outcome, attemptNo, actor: 'webhook', ruleVersion: CAPTURE_RULE_VERSION,
        reasonCodes: detail?.reasonCodes ?? [], detail: detail?.info ?? null,
      });
    });
  }

  /** Classification annotations (G.2 step 7): never completion markers, never attribution (business_id stays NULL in F1). */
  async annotate(eventRecordId: string, disposition: Annotation, reasonCodes: string[], info?: Record<string, unknown>): Promise<void> {
    await this.db.insert(stripeProviderEventDispositions).values({
      eventRecordId, disposition, reasonCodes, actor: 'webhook', ruleVersion: CAPTURE_RULE_VERSION, detail: info ?? null,
    });
  }

  /** Idempotent annotation: a replay or a crash-recovery re-classification never duplicates the same annotation. */
  async annotateOnce(eventRecordId: string, disposition: Annotation, reasonCodes: string[], info?: Record<string, unknown>): Promise<boolean> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'stripe_evidence_annotate:' + eventRecordId}, 0))`);
      const d = stripeProviderEventDispositions;
      const existing = await tx.select({ id: d.id }).from(d)
        .where(and(eq(d.eventRecordId, eventRecordId), eq(d.disposition, disposition), sql`${d.reasonCodes} = ${sql.raw(`ARRAY[${reasonCodes.map(c => `'${c.replace(/'/g, "''")}'`).join(',')}]::text[]`)}`)).limit(1);
      if (existing.length > 0) return false;
      await tx.insert(d).values({ eventRecordId, disposition, reasonCodes, actor: 'webhook', ruleVersion: CAPTURE_RULE_VERSION, detail: info ?? null });
      return true;
    });
  }
}
