import { describe, it, expect } from 'vitest';
import { appendRevision, effectiveAsKnownAt, resolveChain, usableAt, type RevisionRecord } from './supersession';

const S = 'scope-1';
const rec = (revision: number, over: Partial<RevisionRecord> = {}): RevisionRecord => ({
  id: `r${revision}`, scopeKey: S, revision, supersedes: revision === 1 ? null : `r${revision - 1}`, state: 'active', effectiveFrom: 100 * revision, recordedAt: 1000 * revision, ...over,
});
const chainOf = (...rs: RevisionRecord[]) => rs;

describe('G4 bitemporal append-only supersession (pure)', () => {
  it('resolves one head from a valid chain, in any input order', () => {
    const rs = chainOf(rec(1), rec(2), rec(3));
    for (const order of [rs, [rs[2]!, rs[0]!, rs[1]!], [...rs].reverse()]) expect(resolveChain(order)).toMatchObject({ ok: true, head: { id: 'r3' } });
  });

  it.each([
    ['empty', [], 'EMPTY'],
    ['duplicate id', [rec(1), rec(2, { id: 'r1' })], 'DUPLICATE_ID'],
    ['mixed scope', [rec(1), rec(2, { scopeKey: 'other' })], 'MIXED_SCOPE'],
    ['first revision with a predecessor', [rec(1, { supersedes: 'x' })], 'BAD_FIRST_REVISION'],
    ['first revision not 1', [rec(2, { supersedes: null })], 'BAD_FIRST_REVISION'],
    ['two roots', [rec(1), rec(2, { supersedes: null })], 'BAD_FIRST_REVISION'],
    ['competing successors (fork)', [rec(1), rec(2), rec(2, { id: 'r2b' })], 'FORK'],
    ['unknown predecessor', [rec(1), rec(2, { supersedes: 'ghost' })], 'UNKNOWN_PREDECESSOR'],
    ['revision skipped', [rec(1), rec(2, { revision: 3 })], 'REVISION_NOT_MONOTONIC'],
    ['recorded time regresses', [rec(1), rec(2, { recordedAt: 10 })], 'RECORDED_TIME_REGRESSION'],
    ['unreachable record (gap)', [rec(1), rec(2), rec(5, { supersedes: 'r4x' }), rec(4, { id: 'r4x', supersedes: 'r5' })], 'CYCLE'],
    ['invalid record', [rec(1, { effectiveFrom: Number.NaN })], 'INVALID_RECORD'],
  ] as const)('fails closed: %s', (_n, rs, error) => {
    const r = resolveChain([...rs] as unknown as RevisionRecord[]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error === error || (error === 'CYCLE' && ['CYCLE', 'GAP', 'UNKNOWN_PREDECESSOR'].includes(r.error))).toBe(true);
  });

  it('a detached record that is not reachable from revision 1 fails closed', () => {
    expect(resolveChain([rec(1), rec(2), { ...rec(3), id: 'island', supersedes: 'island2' }, { ...rec(4), id: 'island2', supersedes: 'island' }])).toMatchObject({ ok: false });
  });

  it('expected-predecessor check: of two writers with the same expectation exactly one wins, and the loser must re-read', () => {
    const base = chainOf(rec(1));
    const a = appendRevision(base, rec(2), 'r1');
    const b = appendRevision(base, rec(2, { id: 'r2-other' }), 'r1');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // each is valid against ITS read of the chain...
    const afterA = a.ok ? a.chain : base;
    const loser = appendRevision(afterA, rec(2, { id: 'r2-other' }), 'r1'); // ...but applied to the current chain the second is stale
    expect(loser).toEqual({ ok: false, error: 'STALE_PREDECESSOR', currentHeadId: 'r2' });
    expect(resolveChain([...afterA, rec(2, { id: 'r2-other' })])).toMatchObject({ ok: false, error: 'FORK' }); // and a forced write would fork, which also fails closed
  });

  it('append never mutates existing records and refuses to extend a broken chain', () => {
    const base = chainOf(rec(1), rec(2));
    const snapshot = JSON.stringify(base);
    const ok = appendRevision(base, rec(3), 'r2');
    expect(ok).toMatchObject({ ok: true, head: { id: 'r3' } });
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(appendRevision([rec(1), rec(2), rec(2, { id: 'x' })], rec(3), 'r2')).toMatchObject({ ok: false, error: 'FORK' });
    expect(appendRevision(base, rec(3), null)).toMatchObject({ ok: false, error: 'FIRST_REVISION_EXISTS', currentHeadId: 'r2' });
    expect(appendRevision(base, rec(3, { supersedes: 'r1' }), 'r2')).toMatchObject({ ok: false });
    expect(appendRevision([], rec(1), null)).toMatchObject({ ok: true, head: { id: 'r1' } });
    expect(appendRevision([], rec(1), 'r0')).toMatchObject({ ok: false, error: 'BAD_FIRST_REVISION' });
  });

  describe('revocation and compromise', () => {
    it('leaving revoked or compromised requires an auditable recovery reference', () => {
      for (const bad of ['revoked', 'compromised'] as const) {
        const rs = chainOf(rec(1), rec(2, { state: bad }));
        expect(appendRevision(rs, rec(3), 'r2')).toMatchObject({ ok: false, error: 'RECOVERY_REF_REQUIRED' });
        expect(appendRevision(rs, rec(3, { recoveryRef: '  ' }), 'r2')).toMatchObject({ ok: false, error: 'RECOVERY_REF_REQUIRED' });
        expect(appendRevision(rs, rec(3, { recoveryRef: 'incident-42' }), 'r2')).toMatchObject({ ok: true });
      }
    });

    it('a compromised or revoked period is never restored retroactively', () => {
      const compromised = chainOf(rec(1, { effectiveFrom: 100 }), rec(2, { state: 'compromised', effectiveFrom: 200 }));
      expect(appendRevision(compromised, rec(3, { effectiveFrom: 150, recoveryRef: 'x' }), 'r2')).toMatchObject({ ok: false, error: 'RETROACTIVE_RESTORATION' });
      expect(appendRevision(compromised, rec(3, { effectiveFrom: 200, recoveryRef: 'x' }), 'r2')).toMatchObject({ ok: false, error: 'RETROACTIVE_RESTORATION' });
      const recovered = appendRevision(compromised, rec(3, { effectiveFrom: 300, recoveryRef: 'x' }), 'r2');
      expect(recovered).toMatchObject({ ok: true });
      // the loophole: a later ordinary correction cannot reach back across the compromised window either
      const chain = recovered.ok ? recovered.chain : [];
      expect(appendRevision(chain, rec(4, { effectiveFrom: 250 }), 'r3')).toMatchObject({ ok: false, error: 'RETROACTIVE_RESTORATION' });
      expect(appendRevision(chain, rec(4, { effectiveFrom: 299 }), 'r3')).toMatchObject({ ok: false, error: 'RETROACTIVE_RESTORATION' });
      expect(appendRevision(chain, rec(4, { effectiveFrom: 300 }), 'r3')).toMatchObject({ ok: true }); // same period as the recovery: nothing reopened
      expect(appendRevision(chain, rec(4, { effectiveFrom: 301 }), 'r3')).toMatchObject({ ok: true });
      // revoking again, even retroactively, only restricts and is allowed
      expect(appendRevision(chain, rec(4, { state: 'revoked', effectiveFrom: 50 }), 'r3')).toMatchObject({ ok: true });
    });

    it('usability follows valid time and the explicit state; broken chains are never usable', () => {
      const rs = chainOf(rec(1, { effectiveFrom: 100 }), rec(2, { state: 'compromised', effectiveFrom: 200 }), rec(3, { effectiveFrom: 300, recoveryRef: 'ir-1' }));
      expect(usableAt(rs, 50)).toEqual({ usable: false, reason: 'NOT_YET_EFFECTIVE' });
      expect(usableAt(rs, 150)).toMatchObject({ usable: true, record: { id: 'r1' } });
      expect(usableAt(rs, 250)).toMatchObject({ usable: false, reason: 'COMPROMISED' });
      expect(usableAt(rs, 300)).toMatchObject({ usable: true, record: { id: 'r3' } });
      expect(usableAt([rec(1, { effectiveFrom: 0 }), rec(2, { state: 'revoked', effectiveFrom: 10 })], 10)).toMatchObject({ usable: false, reason: 'REVOKED' });
      expect(usableAt([rec(1), rec(2), rec(2, { id: 'fork' })], 500)).toEqual({ usable: false, reason: 'NO_CHAIN' });
      expect(usableAt(rs, Number.NaN)).toEqual({ usable: false, reason: 'INVALID_INSTANT' });
    });
  });

  it('bitemporal: the same valid-time question has different answers depending on what was known (transaction-time travel)', () => {
    const rs = chainOf(rec(1, { effectiveFrom: 100, recordedAt: 1000 }), rec(2, { state: 'revoked', effectiveFrom: 150, recordedAt: 5000 }));
    expect(usableAt(rs, 200, 4000)).toMatchObject({ usable: true, record: { id: 'r1' } }); // before we learned of the revocation
    expect(usableAt(rs, 200, 6000)).toMatchObject({ usable: false, reason: 'REVOKED' }); // after
    expect(usableAt(rs, 200)).toMatchObject({ usable: false, reason: 'REVOKED' });
    expect(effectiveAsKnownAt(rs, 4000)).toMatchObject({ ok: true, head: { id: 'r1' } });
    expect(effectiveAsKnownAt(rs, 500)).toMatchObject({ ok: false, error: 'EMPTY' });
    expect(effectiveAsKnownAt(rs, Number.NaN)).toMatchObject({ ok: false });
  });

  it('property: random append attempts never produce a fork, regress recorded time, restore a restricted period, or alter history', () => {
    let seed = 4242;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let run = 0; run < 400; run++) {
      let chain: readonly RevisionRecord[] = [];
      let n = 0;
      for (let i = 0; i < 20; i++) {
        const head = chain[chain.length - 1];
        const stale = rnd(5) === 0 && chain.length > 1;
        const expected = chain.length === 0 ? null : stale ? chain[0]!.id : head!.id;
        n++;
        const cand: RevisionRecord = {
          id: `x${run}-${n}`, scopeKey: S, revision: chain.length + 1, supersedes: head ? head.id : null,
          state: (['active', 'active', 'revoked', 'compromised'] as const)[rnd(4)]!, effectiveFrom: rnd(1000), recordedAt: (head?.recordedAt ?? 0) + rnd(50),
          ...(rnd(2) ? { recoveryRef: 'ref' } : {}),
        };
        const before = JSON.stringify(chain);
        const r = appendRevision(chain, cand, expected);
        expect(JSON.stringify(chain)).toBe(before);
        if (r.ok) chain = r.chain;
      }
      const resolved = resolveChain(chain);
      if (chain.length > 0) expect(resolved.ok).toBe(true);
      let restricted = Number.NEGATIVE_INFINITY;
      let floor = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < chain.length; k++) {
        const c = chain[k]!;
        if (k > 0) expect(c.recordedAt).toBeGreaterThanOrEqual(chain[k - 1]!.recordedAt);
        if (c.state === 'active') expect(c.effectiveFrom).toBeGreaterThanOrEqual(floor);
        else restricted = Math.max(restricted, c.effectiveFrom);
        if (c.state !== 'active' || (k > 0 && chain[k - 1]!.state !== 'active')) floor = Math.max(floor, c.effectiveFrom);
        if (k > 0 && chain[k - 1]!.state !== 'active' && c.state === 'active') expect(c.recoveryRef).toBeTruthy();
      }
    }
  });
});
