import { describe, expect, it } from 'vitest';
import { chainAudit, SelectionError, selectEntrants, uniformBelow, verifyChain, verifySelection, type RandomBytes } from './shuffle-selection';

const seq = (vals: number[]): RandomBytes => { let i = 0; return () => { const v = vals[i++ % vals.length]!; return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }; };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${String(i).padStart(3, '0')}`);

describe('selection primitive (isolated, synthetic)', () => {
  it('rejects invalid input', () => {
    expect(() => selectEntrants({ entrantIds: [], winnerCount: 1 })).toThrow(SelectionError);
    expect(() => selectEntrants({ entrantIds: ['a', 'a'], winnerCount: 1 })).toThrow(/unique/);
    for (const w of [0, -1, 1.5, 4]) expect(() => selectEntrants({ entrantIds: ['a', 'b', 'c'], winnerCount: w })).toThrow(SelectionError);
  });
  it('selects exactly winnerCount distinct entrants from the pool; every entrant selected when winnerCount = n', () => {
    const r = selectEntrants({ entrantIds: ids(20), winnerCount: 5 });
    expect(new Set(r.selectedIds).size).toBe(5);
    for (const s of r.selectedIds) expect(ids(20)).toContain(s);
    expect(selectEntrants({ entrantIds: ids(4), winnerCount: 4 }).selectedIds).toEqual(ids(4));
  });
  it('is independent of input order for a fixed random stream, and commits input and result', () => {
    const a = selectEntrants({ entrantIds: ids(10), winnerCount: 3 }, seq([7, 123456789, 42]));
    const b = selectEntrants({ entrantIds: [...ids(10)].reverse(), winnerCount: 3 }, seq([7, 123456789, 42]));
    expect(b).toEqual(a);
    expect(a.inputCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(selectEntrants({ entrantIds: ids(10), winnerCount: 4 }, seq([7, 123456789, 42])).inputCommitment).not.toBe(a.inputCommitment);
  });
  it('rejection sampling removes modulo bias: draws in the biased tail are discarded', () => {
    const bound = 3; const limit = 0x100000000 - (0x100000000 % bound);
    expect(uniformBelow(bound, seq([limit, limit, 4]))).toBe(4 % 3);
    expect(() => uniformBelow(0, seq([1]))).toThrow(RangeError);
  });
  it('is statistically uniform over a CSPRNG (chi-square sanity, 1 of 5, 50k trials)', () => {
    const counts = [0, 0, 0, 0, 0]; const e = ids(5);
    for (let i = 0; i < 50_000; i++) counts[e.indexOf(selectEntrants({ entrantIds: e, winnerCount: 1 }).selectedIds[0]!)]!++;
    const exp = 10_000; const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(18.5); // df=4, p≈0.001
  });
  it('REGRESSION: the audit hash commits nested event fields (a key-list replacer used to drop them)', () => {
    const a = chainAudit(null, { kind: 'selection', detail: { winners: ['x'], count: 1 } });
    const b = chainAudit(null, { kind: 'selection', detail: { winners: ['y'], count: 1 } });
    expect(a.hash).not.toBe(b.hash);
    expect(chainAudit(null, { z: 1, a: { q: 2, b: 3 } }).hash).toBe(chainAudit(null, { a: { b: 3, q: 2 }, z: 1 }).hash);
    expect(() => chainAudit(null, { a: undefined })).toThrow(TypeError);
  });
  it('audit chain is tamper-evident: edit, removal, insertion and reorder are all detected', () => {
    const l1 = chainAudit(null, { a: { n: 1 } }); const l2 = chainAudit(l1.hash, { b: { n: 2 } }); const l3 = chainAudit(l2.hash, { c: { n: 3 } });
    expect(verifyChain([l1, l2, l3])).toBe(true);
    expect(verifyChain([])).toBe(true);
    expect(verifyChain([l1, { ...l2, event: { b: { n: 9 } } }, l3])).toBe(false);
    expect(verifyChain([l1, l3])).toBe(false);
    expect(verifyChain([l1, l3, l2])).toBe(false);
    expect(verifyChain([l2, l3])).toBe(false);
    expect(verifyChain([l1, chainAudit(l1.hash, { x: 1 }), l2])).toBe(false);
  });
  it('recorded evidence verifies by deterministic replay; any tampering is rejected', () => {
    const input = { entrantIds: ids(12), winnerCount: 3 };
    const r = selectEntrants(input);
    expect(verifySelection(input, r)).toBe(true);
    const other = ids(12).filter((x) => !r.selectedIds.includes(x))[0]!;
    expect(verifySelection(input, { ...r, selectedIds: [other, ...r.selectedIds.slice(1)] })).toBe(false);
    expect(verifySelection(input, { ...r, resultCommitment: 'a'.repeat(64) })).toBe(false);
    expect(verifySelection(input, { ...r, transcript: r.transcript.slice(1) })).toBe(false);
    expect(verifySelection(input, { ...r, transcript: [...r.transcript, '00000000'] })).toBe(false);
    expect(verifySelection({ ...input, winnerCount: 4 }, r)).toBe(false);
    expect(verifySelection({ entrantIds: [...ids(11), 'zzz'], winnerCount: 3 }, r)).toBe(false);
  });
});
