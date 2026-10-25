import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { hetaProvenanceComparisons, hetaReconciliationWork, hetaRecordRevisions } from '../../db/schema';
import type { ClassifiedProvenanceComparison } from './classified-provider-comparison';
import { appendRevision, effectiveAsKnownAt, resolveChain, usableAt, type AppendResult, type RevisionRecord, type UsabilityVerdict } from './supersession';

/**
 * HETA Block G persisted foundations (migration 0051): durable reconciliation work (G5), immutable cross-provenance comparison results (G2) and database-
 * backed bitemporal revisions (G4). Evidence-consistency bookkeeping only. Nothing here decrypts evidence, calls a provider, attributes an event to a
 * tenant, certifies history, grants an attestation or authorizes anything financial, and nothing in the application invokes it yet.
 */

// ---------------------------------------------------------------- G5: leased, fenced work queue
export type WorkKind = 'compare_provenance' | 'retrieve_event' | 'reconcile_window';
export interface ClaimedWork { id: string; kind: WorkKind; subjectKey: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number; leaseToken: string; leaseExpiresAt: Date }
const CODE = /^[a-z0-9_]{1,64}$/;

export class HetaWorkQueue {
  constructor(private readonly db: Database) {}

  /** Idempotent: the same kind and subject enqueue once, however many times it is requested. */
  async enqueue(input: { kind: WorkKind; subjectKey: string; payload?: Record<string, unknown>; maxAttempts?: number; notBefore?: Date }): Promise<{ id: string; created: boolean }> {
    const dedupeKey = `${input.kind}:${input.subjectKey}`;
    const inserted = await this.db.insert(hetaReconciliationWork).values({
      kind: input.kind, subjectKey: input.subjectKey, dedupeKey, payload: input.payload ?? {}, maxAttempts: input.maxAttempts ?? 5, ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    }).onConflictDoNothing({ target: hetaReconciliationWork.dedupeKey }).returning({ id: hetaReconciliationWork.id });
    if (inserted[0]) return { id: inserted[0].id, created: true };
    const [existing] = await this.db.select({ id: hetaReconciliationWork.id }).from(hetaReconciliationWork).where(eq(hetaReconciliationWork.dedupeKey, dedupeKey));
    return { id: existing!.id, created: false };
  }

  /**
   * Claims up to `limit` due items under a lease. Pending items whose `not_before` has passed AND leased items whose lease expired (their worker died or
   * stalled) are eligible, taken with SKIP LOCKED so concurrent workers get distinct items. Every claim consumes an attempt; an item that has used all of
   * its attempts is marked dead instead of being handed out again. Each claim gets a fresh fencing token.
   */
  async claim(input: { owner: string; leaseMs: number; limit?: number; kinds?: readonly WorkKind[]; now?: Date }): Promise<ClaimedWork[]> {
    if (!input.owner || !Number.isFinite(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 3_600_000) throw new Error('HETA_WORK_CLAIM_INVALID');
    const now = input.now ?? new Date();
    const limit = Math.min(Math.max(input.limit ?? 1, 1), 100);
    return this.db.transaction(async tx => {
      const due = await tx.select().from(hetaReconciliationWork)
        .where(and(
          or(and(eq(hetaReconciliationWork.state, 'pending'), lte(hetaReconciliationWork.notBefore, now)), and(eq(hetaReconciliationWork.state, 'leased'), lte(hetaReconciliationWork.leaseExpiresAt, now))),
          input.kinds ? inArray(hetaReconciliationWork.kind, [...input.kinds]) : undefined,
        ))
        .orderBy(asc(hetaReconciliationWork.notBefore), asc(hetaReconciliationWork.createdAt)).limit(limit).for('update', { skipLocked: true });
      const out: ClaimedWork[] = [];
      for (const w of due) {
        if (w.attempts >= w.maxAttempts) {
          await tx.update(hetaReconciliationWork).set({ state: 'dead', leaseToken: null, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: w.lastErrorCode ?? 'attempts_exhausted', completedAt: now, updatedAt: now }).where(eq(hetaReconciliationWork.id, w.id));
          continue;
        }
        const leaseToken = crypto.randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
        await tx.update(hetaReconciliationWork).set({ state: 'leased', leaseToken, leaseOwner: input.owner, leaseExpiresAt, attempts: w.attempts + 1, updatedAt: now }).where(eq(hetaReconciliationWork.id, w.id));
        out.push({ id: w.id, kind: w.kind, subjectKey: w.subjectKey, payload: w.payload, attempts: w.attempts + 1, maxAttempts: w.maxAttempts, leaseToken, leaseExpiresAt });
      }
      return out;
    });
  }

  /** Extends a LIVE lease. A stale token, or a lease that already expired, returns false: the worker has lost the item. */
  async heartbeat(id: string, leaseToken: string, leaseMs: number, now = new Date()): Promise<boolean> {
    const r = await this.db.update(hetaReconciliationWork).set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
      .where(and(eq(hetaReconciliationWork.id, id), eq(hetaReconciliationWork.state, 'leased'), eq(hetaReconciliationWork.leaseToken, leaseToken), sql`${hetaReconciliationWork.leaseExpiresAt} > ${now}`)).returning({ id: hetaReconciliationWork.id });
    return r.length === 1;
  }

  /** Fenced: only the current, unexpired lease holder can complete. A worker whose lease was reclaimed can never overwrite the new holder's outcome. */
  async complete(id: string, leaseToken: string, now = new Date()): Promise<boolean> {
    const r = await this.db.update(hetaReconciliationWork).set({ state: 'done', leaseToken: null, leaseOwner: null, leaseExpiresAt: null, completedAt: now, updatedAt: now })
      .where(and(eq(hetaReconciliationWork.id, id), eq(hetaReconciliationWork.state, 'leased'), eq(hetaReconciliationWork.leaseToken, leaseToken), sql`${hetaReconciliationWork.leaseExpiresAt} > ${now}`)).returning({ id: hetaReconciliationWork.id });
    return r.length === 1;
  }

  /** Fenced failure: retried after `retryDelayMs` until attempts are exhausted, then dead. Only a redacted machine code is stored. */
  async fail(id: string, leaseToken: string, errorCode: string, opts: { retryDelayMs?: number; now?: Date } = {}): Promise<'retry' | 'dead' | 'stale'> {
    const now = opts.now ?? new Date();
    const code = CODE.test(errorCode) ? errorCode : 'unspecified_error';
    return this.db.transaction(async tx => {
      const [w] = await tx.select().from(hetaReconciliationWork).where(and(eq(hetaReconciliationWork.id, id), eq(hetaReconciliationWork.state, 'leased'), eq(hetaReconciliationWork.leaseToken, leaseToken), sql`${hetaReconciliationWork.leaseExpiresAt} > ${now}`)).for('update');
      if (!w) return 'stale' as const;
      if (w.attempts >= w.maxAttempts) {
        await tx.update(hetaReconciliationWork).set({ state: 'dead', leaseToken: null, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: code, completedAt: now, updatedAt: now }).where(eq(hetaReconciliationWork.id, id));
        return 'dead' as const;
      }
      await tx.update(hetaReconciliationWork).set({ state: 'pending', leaseToken: null, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: code, notBefore: new Date(now.getTime() + Math.max(opts.retryDelayMs ?? 30_000, 0)), updatedAt: now }).where(eq(hetaReconciliationWork.id, id));
      return 'retry' as const;
    });
  }
}

// ---------------------------------------------------------------- G2: immutable comparison results
export type ComparisonDisposition = 'corroborated_fields' | 'conflicted' | 'incomparable' | 'unassessed';

/** Maps the typed, non-authoritative comparison to its persisted disposition. `null` = no retrieved counterpart yet (`unassessed`). */
export function dispositionOf(c: ClassifiedProvenanceComparison | null): { disposition: ComparisonDisposition; mismatches: Record<string, unknown>[]; reasons: string[] } {
  if (c === null) return { disposition: 'unassessed', mismatches: [], reasons: [] };
  if (c.status === 'matched') return { disposition: 'corroborated_fields', mismatches: [], reasons: [] };
  if (c.status === 'mismatched') return { disposition: 'conflicted', mismatches: c.mismatches.map(m => ({ field: m.field, webhook: m.webhook, retrieved: m.retrieved })), reasons: [] };
  if (c.status === 'insufficient_evidence') return { disposition: 'incomparable', mismatches: [], reasons: [...c.reasons] };
  return { disposition: 'incomparable', mismatches: [], reasons: [`unusable_${c.source}_envelope`, `parse_${String(c.parseStatus)}`, ...c.defects.map(d => `defect_${String(d)}`)] };
}

export async function recordProvenanceComparison(db: Database, input: { webhookRecordId: string; retrievedRecordId: string | null; comparison: ClassifiedProvenanceComparison | null; ruleVersion: string }): Promise<{ id: string; replay: boolean }> {
  const d = dispositionOf(input.comparison);
  if ((input.retrievedRecordId === null) !== (input.comparison === null)) throw new Error('HETA_COMPARISON_INPUT_INVALID');
  const inserted = await db.insert(hetaProvenanceComparisons).values({ webhookRecordId: input.webhookRecordId, retrievedRecordId: input.retrievedRecordId, disposition: d.disposition, mismatches: d.mismatches, reasons: d.reasons, ruleVersion: input.ruleVersion })
    .onConflictDoNothing().returning({ id: hetaProvenanceComparisons.id });
  if (inserted[0]) return { id: inserted[0].id, replay: false };
  const [existing] = await db.select({ id: hetaProvenanceComparisons.id, disposition: hetaProvenanceComparisons.disposition }).from(hetaProvenanceComparisons)
    .where(and(eq(hetaProvenanceComparisons.webhookRecordId, input.webhookRecordId), eq(hetaProvenanceComparisons.ruleVersion, input.ruleVersion),
      input.retrievedRecordId === null ? sql`${hetaProvenanceComparisons.retrievedRecordId} IS NULL` : eq(hetaProvenanceComparisons.retrievedRecordId, input.retrievedRecordId)));
  if (!existing) throw new Error('HETA_COMPARISON_INSERT_FAILED');
  // The same pair under the same rule must reach the same disposition; a different one is a defect in the caller, not something to overwrite.
  if (existing.disposition !== d.disposition) throw new Error('HETA_COMPARISON_DISPOSITION_CONFLICT');
  return { id: existing.id, replay: true };
}

// ---------------------------------------------------------------- G4: database-backed bitemporal revisions
const toRecord = (r: typeof hetaRecordRevisions.$inferSelect): RevisionRecord => ({
  id: r.id, scopeKey: r.scopeKey, revision: r.revision, supersedes: r.supersedes, state: r.state, effectiveFrom: r.effectiveFrom.getTime(), recordedAt: r.recordedAt.getTime(),
  ...(r.recoveryRef ? { recoveryRef: r.recoveryRef } : {}),
});

export class HetaRevisionChain {
  constructor(private readonly db: Database) {}

  async read(scopeKey: string): Promise<RevisionRecord[]> {
    const rows = await this.db.select().from(hetaRecordRevisions).where(eq(hetaRecordRevisions.scopeKey, scopeKey)).orderBy(asc(hetaRecordRevisions.revision));
    return rows.map(toRecord);
  }

  /**
   * Serialized per scope by an advisory transaction lock, then validated by the pure chain rules (expected predecessor, monotonic revisions, recovery,
   * no retroactive restoration) and finally by the database triggers and unique keys, which make a fork impossible even if this code were bypassed.
   */
  async append(scopeKey: string, candidate: { state: RevisionRecord['state']; effectiveFrom: Date; recoveryRef?: string; subjectRef?: string; recordedAt?: Date }, expectedPredecessorId: string | null): Promise<AppendResult> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'heta_record_revisions:' + scopeKey}, 0))`);
      const rows = await tx.select().from(hetaRecordRevisions).where(eq(hetaRecordRevisions.scopeKey, scopeKey)).orderBy(asc(hetaRecordRevisions.revision));
      const existing = rows.map(toRecord);
      const head = existing[existing.length - 1];
      const recordedAt = candidate.recordedAt ?? new Date(Math.max(Date.now(), head?.recordedAt ?? 0));
      const record: RevisionRecord = {
        id: crypto.randomUUID(), scopeKey, revision: (head?.revision ?? 0) + 1, supersedes: head?.id ?? null, state: candidate.state,
        effectiveFrom: candidate.effectiveFrom.getTime(), recordedAt: recordedAt.getTime(), ...(candidate.recoveryRef ? { recoveryRef: candidate.recoveryRef } : {}),
      };
      const r = appendRevision(existing, record, expectedPredecessorId);
      if (!r.ok) return r;
      await tx.insert(hetaRecordRevisions).values({
        id: record.id, scopeKey, revision: record.revision, supersedes: record.supersedes, state: record.state, effectiveFrom: new Date(record.effectiveFrom), recordedAt,
        recoveryRef: candidate.recoveryRef ?? null, subjectRef: candidate.subjectRef ?? null,
      });
      return r;
    });
  }

  async effective(scopeKey: string, knownAt?: number) {
    const rs = await this.read(scopeKey);
    return knownAt === undefined ? resolveChain(rs) : effectiveAsKnownAt(rs, knownAt);
  }

  async usable(scopeKey: string, instant: number, knownAt?: number): Promise<UsabilityVerdict> {
    return usableAt(await this.read(scopeKey), instant, knownAt);
  }
}
