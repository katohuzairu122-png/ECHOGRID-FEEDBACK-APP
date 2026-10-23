/**
 * HETA Block G4 (owner decision 2026-10-23): append-only BITEMPORAL revocation and supersession of an evidence-derived record
 * (an assessment, an attestation, a binding).
 *
 * PURE and NON-ACTIVATING: it validates and extends an in-memory chain; it persists nothing and authorizes nothing. Two times are kept apart: the
 * record's EFFECTIVE time (when it is meant to apply) and its RECORDED time (when we learned it). A record is never edited or deleted; a change is a
 * new revision that names its exact predecessor. Concurrent writers are serialized by an expected-predecessor check, and any ambiguity (fork,
 * gap, cycle, regression of recorded time, unresolved competing successors) fails closed with no effective record.
 */
export type RecordState = 'active' | 'revoked' | 'compromised';

export interface RevisionRecord {
  id: string;
  scopeKey: string;
  /** Monotonic from 1 within a scope. */
  revision: number;
  /** Exact predecessor id; null only for revision 1. */
  supersedes: string | null;
  state: RecordState;
  /** Epoch ms the record is meant to apply from (valid time). */
  effectiveFrom: number;
  /** Epoch ms the system recorded it (transaction time). Never earlier than the predecessor's. */
  recordedAt: number;
  /** Required to leave `revoked` or `compromised`; points at the auditable recovery evidence. */
  recoveryRef?: string;
}

export type ChainError =
  | 'EMPTY' | 'DUPLICATE_ID' | 'MIXED_SCOPE' | 'BAD_FIRST_REVISION' | 'FORK' | 'GAP' | 'UNKNOWN_PREDECESSOR' | 'CYCLE' | 'REVISION_NOT_MONOTONIC'
  | 'RECORDED_TIME_REGRESSION' | 'RECOVERY_REF_REQUIRED' | 'RETROACTIVE_RESTORATION' | 'INVALID_RECORD';

export type ChainResult = { ok: true; head: RevisionRecord; chain: readonly RevisionRecord[] } | { ok: false; error: ChainError; detail?: string };

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const valid = (r: RevisionRecord): boolean =>
  !!r && typeof r.id === 'string' && r.id !== '' && typeof r.scopeKey === 'string' && r.scopeKey !== '' && Number.isSafeInteger(r.revision) && r.revision >= 1 &&
  (r.supersedes === null || typeof r.supersedes === 'string') && ['active', 'revoked', 'compromised'].includes(r.state) && fin(r.effectiveFrom) && fin(r.recordedAt);

/**
 * Rules for moving from `prev` to `next` (both known to be in one scope with next.supersedes === prev.id).
 *  - `restrictedFrom`: latest effectiveFrom of any revoked/compromised revision so far.
 *  - `floor`: latest effectiveFrom of any revoked/compromised revision OR of a recovery that ended one.
 * A recovery must take effect strictly after the restriction it ends (otherwise it would erase the restricted period), and no later `active`
 * revision may take effect before `floor` (otherwise a corrective revision could reach back across the restricted window and make it valid again).
 */
function checkStep(prev: RevisionRecord, next: RevisionRecord, restrictedFrom: number, floor: number): ChainError | null {
  if (next.revision !== prev.revision + 1) return 'REVISION_NOT_MONOTONIC';
  if (next.recordedAt < prev.recordedAt) return 'RECORDED_TIME_REGRESSION';
  if (next.state !== 'active') return null; // restricting is always allowed, even retroactively
  const recovering = prev.state === 'revoked' || prev.state === 'compromised';
  if (recovering && (!next.recoveryRef || next.recoveryRef.trim() === '')) return 'RECOVERY_REF_REQUIRED';
  if (recovering && next.effectiveFrom <= restrictedFrom) return 'RETROACTIVE_RESTORATION';
  if (next.effectiveFrom < floor) return 'RETROACTIVE_RESTORATION';
  return null;
}

/** Validates one scope's records (any input order) and returns the single head; fails closed on any ambiguity. */
export function resolveChain(records: readonly RevisionRecord[]): ChainResult {
  if (!Array.isArray(records) || records.length === 0) return { ok: false, error: 'EMPTY' };
  if (records.some(r => !valid(r))) return { ok: false, error: 'INVALID_RECORD' };
  if (new Set(records.map(r => r.scopeKey)).size !== 1) return { ok: false, error: 'MIXED_SCOPE' };
  const ids = new Set(records.map(r => r.id));
  if (ids.size !== records.length) return { ok: false, error: 'DUPLICATE_ID' };
  const firsts = records.filter(r => r.supersedes === null);
  if (firsts.length !== 1 || firsts[0]!.revision !== 1) return { ok: false, error: 'BAD_FIRST_REVISION' };
  const bySupersedes = new Map<string, RevisionRecord[]>();
  for (const r of records) {
    if (r.supersedes === null) continue;
    if (!ids.has(r.supersedes)) return { ok: false, error: 'UNKNOWN_PREDECESSOR', detail: r.id };
    bySupersedes.set(r.supersedes, [...(bySupersedes.get(r.supersedes) ?? []), r]);
  }
  for (const [pred, succ] of bySupersedes) if (succ.length > 1) return { ok: false, error: 'FORK', detail: pred }; // competing successors: no effective record
  const chain: RevisionRecord[] = [firsts[0]!];
  const seen = new Set([firsts[0]!.id]);
  let restrictedFrom = firsts[0]!.state === 'active' ? Number.NEGATIVE_INFINITY : firsts[0]!.effectiveFrom;
  let floor = restrictedFrom;
  for (;;) {
    const cur = chain[chain.length - 1]!;
    const next = bySupersedes.get(cur.id)?.[0];
    if (!next) break;
    if (seen.has(next.id)) return { ok: false, error: 'CYCLE', detail: next.id };
    const err = checkStep(cur, next, restrictedFrom, floor);
    if (err) return { ok: false, error: err, detail: next.id };
    if (next.state !== 'active') restrictedFrom = Math.max(restrictedFrom, next.effectiveFrom);
    if (next.state !== 'active' || cur.state !== 'active') floor = Math.max(floor, next.effectiveFrom);
    chain.push(next);
    seen.add(next.id);
  }
  if (chain.length !== records.length) return { ok: false, error: 'GAP' }; // some records are not reachable from revision 1
  return { ok: true, head: chain[chain.length - 1]!, chain };
}

export type AppendResult = { ok: true; chain: readonly RevisionRecord[]; head: RevisionRecord } | { ok: false; error: ChainError | 'STALE_PREDECESSOR' | 'FIRST_REVISION_EXISTS'; currentHeadId?: string };

/**
 * Appends `candidate` only if the caller's `expectedPredecessorId` is still the head (null means "I expect an empty chain"). Of two writers holding the
 * same expectation exactly one succeeds; the other gets STALE_PREDECESSOR and must re-read. The existing records are never modified.
 */
export function appendRevision(existing: readonly RevisionRecord[], candidate: RevisionRecord, expectedPredecessorId: string | null): AppendResult {
  if (!valid(candidate)) return { ok: false, error: 'INVALID_RECORD' };
  if (existing.length === 0) {
    if (expectedPredecessorId !== null || candidate.supersedes !== null || candidate.revision !== 1) return { ok: false, error: 'BAD_FIRST_REVISION' };
    const r = resolveChain([candidate]);
    return r.ok ? { ok: true, chain: r.chain, head: r.head } : { ok: false, error: r.error };
  }
  const current = resolveChain(existing);
  if (!current.ok) return { ok: false, error: current.error }; // never extend a broken chain
  if (expectedPredecessorId === null) return { ok: false, error: 'FIRST_REVISION_EXISTS', currentHeadId: current.head.id };
  if (expectedPredecessorId !== current.head.id) return { ok: false, error: 'STALE_PREDECESSOR', currentHeadId: current.head.id };
  if (candidate.supersedes !== current.head.id) return { ok: false, error: 'UNKNOWN_PREDECESSOR' };
  const merged = resolveChain([...existing, candidate]);
  return merged.ok ? { ok: true, chain: merged.chain, head: merged.head } : { ok: false, error: merged.error };
}

/** The effective record as the system knew it at `knownAt` (transaction-time travel): only records recorded at or before it are considered. */
export function effectiveAsKnownAt(records: readonly RevisionRecord[], knownAt: number): ChainResult {
  if (!fin(knownAt)) return { ok: false, error: 'INVALID_RECORD' };
  return resolveChain(records.filter(r => r.recordedAt <= knownAt));
}

export type UsabilityVerdict = { usable: true; record: RevisionRecord } | { usable: false; reason: 'NO_CHAIN' | 'NOT_YET_EFFECTIVE' | 'REVOKED' | 'COMPROMISED' | 'INVALID_INSTANT'; record?: RevisionRecord };

/**
 * Whether the record applies at `instant` (valid time), as known at `knownAt` (transaction time; defaults to the full chain). The applicable revision is
 * the highest revision whose effectiveFrom <= instant, so a later correction takes effect retroactively for ordinary changes but, by chain rules,
 * never restores a compromised or revoked period. A broken chain is never usable.
 */
export function usableAt(records: readonly RevisionRecord[], instant: number, knownAt: number = Number.POSITIVE_INFINITY): UsabilityVerdict {
  if (!fin(instant) || Number.isNaN(knownAt)) return { usable: false, reason: 'INVALID_INSTANT' };
  const r = knownAt === Number.POSITIVE_INFINITY ? resolveChain(records) : effectiveAsKnownAt(records, knownAt);
  if (!r.ok) return { usable: false, reason: 'NO_CHAIN' };
  const applicable = [...r.chain].reverse().find(x => x.effectiveFrom <= instant);
  if (!applicable) return { usable: false, reason: 'NOT_YET_EFFECTIVE' };
  if (applicable.state === 'revoked') return { usable: false, reason: 'REVOKED', record: applicable };
  if (applicable.state === 'compromised') return { usable: false, reason: 'COMPROMISED', record: applicable };
  return { usable: true, record: applicable };
}
