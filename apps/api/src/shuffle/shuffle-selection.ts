import { createHash } from 'node:crypto';

/**
 * TSH-04 (isolated foundation): pure, in-memory selection primitive. NOT wired to any route, table, entry, invitation or reward: it ships
 * no way to run a real campaign. Real execution stays blocked on legal approval (L-1..L-6) and Owner decisions D-3..D-5.
 *
 * Properties: CSPRNG only (no Math.random), unbiased (rejection sampling + Fisher-Yates), no caller-supplied seed in production use,
 * input-order independent (entrants are canonically sorted), tamper-evident commitment of input and output.
 */
export type RandomBytes = (n: number) => Uint8Array;
export const csprngBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export interface SelectionInput { readonly entrantIds: readonly string[]; readonly winnerCount: number }
export interface SelectionResult { readonly selectedIds: readonly string[]; readonly entrantCount: number; readonly inputCommitment: string; readonly resultCommitment: string }

export class SelectionError extends Error { constructor(readonly code: 'NO_ENTRANTS' | 'DUPLICATE_ENTRANT' | 'INVALID_WINNER_COUNT', m: string) { super(m); } }

/** Uniform integer in [0, bound) by rejection sampling over 32-bit draws (no modulo bias). */
export function uniformBelow(bound: number, rand: RandomBytes): number {
  if (!Number.isInteger(bound) || bound < 1 || bound > 0xffffffff) throw new RangeError('bound out of range');
  const limit = 0x100000000 - (0x100000000 % bound);
  for (;;) {
    const b = rand(4); const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (v < limit) return v % bound;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function selectEntrants(input: SelectionInput, rand: RandomBytes = csprngBytes): SelectionResult {
  const ids = [...input.entrantIds];
  if (ids.length === 0) throw new SelectionError('NO_ENTRANTS', 'No entrants.');
  if (new Set(ids).size !== ids.length) throw new SelectionError('DUPLICATE_ENTRANT', 'Entrant ids must be unique.');
  if (!Number.isInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > ids.length) throw new SelectionError('INVALID_WINNER_COUNT', 'Winner count must be between 1 and the number of entrants.');
  ids.sort();
  const inputCommitment = sha(JSON.stringify({ entrants: ids, winnerCount: input.winnerCount }));
  const pool = [...ids];
  for (let i = pool.length - 1; i > pool.length - 1 - input.winnerCount; i--) {
    const j = uniformBelow(i + 1, rand);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const selectedIds = pool.slice(pool.length - input.winnerCount).sort();
  return { selectedIds, entrantCount: ids.length, inputCommitment, resultCommitment: sha(`${inputCommitment}:${JSON.stringify(selectedIds)}`) };
}

/** Hash-chained audit entry (tamper-evident ordering of selection events). */
export function chainAudit(prevHash: string | null, event: Record<string, unknown>): { hash: string; prev: string | null } {
  return { prev: prevHash, hash: sha(`${prevHash ?? 'GENESIS'}:${JSON.stringify(event, Object.keys(event).sort())}`) };
}
