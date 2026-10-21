import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { stripeEvidenceControlEvents } from '../../db/schema';

/**
 * HETA-01-F1 A.5/E.2: append-only control-event writer. Idempotency comes from the deterministic
 * dedupe_key (ON CONFLICT DO NOTHING). Buckets keep the FIRST incident of each minute: the table is
 * append-only, so per-minute counts cannot be incremented, and incident counts are hints only anyway (D.2).
 */
export type BucketKind = 'capture_precondition_failed' | 'capture_error_observed' | 'oversize_rejected';

export interface ControlEventInput {
  kind: (typeof stripeEvidenceControlEvents.$inferInsert)['eventKind'];
  actor: string;
  stream?: string | undefined;
  cause?: string | undefined;
  dedupeKey?: string | undefined;
  windowStart?: Date | undefined;
  windowEnd?: Date | undefined;
  commitSha?: string | undefined;
  approvalRef?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

export const streamOf = (receivingAccountId: string, livemode: boolean | string) => `${receivingAccountId}:${livemode}`;
export const minuteEpoch = (at: Date) => Math.floor(at.getTime() / 60000);
export const bucketKey = (stream: string, kind: BucketKind, at: Date) => `b:${stream}:${kind}:${minuteEpoch(at)}`;

const BUCKET_CAUSE: Record<BucketKind, string> = {
  capture_precondition_failed: 'precondition_failed',
  capture_error_observed: 'http_500',
  oversize_rejected: 'http_413',
};

export class ControlEventWriter {
  constructor(private readonly db: Db) {}

  /** Returns true when a new row was written, false when the dedupe key already existed. */
  async append(e: ControlEventInput): Promise<boolean> {
    const rows = await this.db
      .insert(stripeEvidenceControlEvents)
      .values({
        eventKind: e.kind, actor: e.actor, stream: e.stream ?? null, cause: e.cause ?? null, dedupeKey: e.dedupeKey ?? null,
        windowStart: e.windowStart ?? null, windowEnd: e.windowEnd ?? null, commitSha: e.commitSha ?? null, approvalRef: e.approvalRef ?? null,
        details: e.details ?? {},
      })
      .onConflictDoNothing({ target: stripeEvidenceControlEvents.dedupeKey })
      .returning({ id: stripeEvidenceControlEvents.id });
    return rows.length > 0;
  }

  /** One row per (stream, kind, minute). Details must be schema-limited (codes and counts, never payloads or secrets). */
  bucket(kind: BucketKind, stream: string, at: Date, details: Record<string, unknown>): Promise<boolean> {
    return this.append({ kind, actor: 'webhook', stream, dedupeKey: bucketKey(stream, kind, at), details: { bucketStart: new Date(minuteEpoch(at) * 60000).toISOString(), firstIncidentAt: at.toISOString(), ...details } });
  }

  /** The newest attestation for the stream by seq; a later `failed` supersedes an earlier `passed`. */
  async latestAttestation(stream: string): Promise<{ id: string; passed: boolean; occurredAt: Date } | null> {
    const c = stripeEvidenceControlEvents;
    const r = (
      await this.db
        .select({ id: c.id, result: sql<string | null>`${c.details}->>'result'`, occurredAt: c.occurredAt })
        .from(c)
        .where(and(eq(c.eventKind, 'account_provenance_verified'), eq(c.stream, stream)))
        .orderBy(desc(c.seq))
        .limit(1)
    )[0];
    return r ? { id: r.id, passed: r.result === 'passed', occurredAt: r.occurredAt } : null;
  }

  /** Bucket cause used by the E.2 derivation. */
  static causeOf(kind: BucketKind): string {
    return BUCKET_CAUSE[kind];
  }
}
