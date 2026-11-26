import { describe, expect, it } from 'vitest';
import { evaluateQualification, hashSpec, parseQualificationSpec, QualificationSpecError } from './qualification-spec';

const P = { metric: 'recorded_purchases', threshold: 2 } as const;
const R = { metric: 'referral_attributed', threshold: 1 } as const;
const m = (n: number) => ({ observed: n, evidenceIds: Array.from({ length: n }, (_, i) => `e${i}`) });

describe('shared qualification spec (closed schema)', () => {
  it('accepts a minimal ALL rule with exact decimal string amounts and a currency', () => {
    const s = parseQualificationSpec({ combinator: 'ALL', pathways: [{ ...P, minAmount: '12.50', currency: 'USD', sinceAttribution: true }, R] });
    expect(s.pathways[0]).toMatchObject({ minAmount: '12.50', currency: 'USD' });
  });
  it.each<[unknown, string]>([
    [{}, 'empty'], [{ combinator: 'XOR', pathways: [P] }, 'unknown combinator'], [{ combinator: 'ANY', pathways: [] }, 'no pathways'],
    [{ combinator: 'ANY', pathways: [P], script: 'x' }, 'extra key'], [{ combinator: 'ANY', pathways: [{ ...P, threshold: 0 }] }, 'zero threshold'],
    [{ combinator: 'ANY', pathways: [{ ...P, minAmount: '12.505', currency: 'USD' }] }, 'three decimals'], [{ combinator: 'ANY', pathways: [{ ...P, minAmount: 12.5, currency: 'USD' }] }, 'float amount'],
    [{ combinator: 'ANY', pathways: [{ ...P, minAmount: '5' }] }, 'amount without currency'], [{ combinator: 'ANY', pathways: [{ ...P, currency: 'usd' }] }, 'bad currency'],
    [{ combinator: 'AT_LEAST', pathways: [P, R] }, 'AT_LEAST without n'], [{ combinator: 'ANY', atLeast: 1, pathways: [P] }, 'n without AT_LEAST'], [{ combinator: 'AT_LEAST', atLeast: 3, pathways: [P, R] }, 'n too large'],
    [{ combinator: 'ANY', pathways: [{ ...R, minAmount: '1', currency: 'USD' }] }, 'amount on a non-purchase metric'], [{ combinator: 'ANY', pathways: [{ metric: 'a + b', threshold: 1 }] }, 'expression metric'],
    [{ combinator: 'ANY', pathways: Array.from({ length: 9 }, () => P) }, 'too many pathways'],
  ])('refuses %j (%s)', (raw) => { expect(() => parseQualificationSpec(raw)).toThrow(QualificationSpecError); });
  it('hashes canonically (key order and undefined fields never change the hash; any value does)', () => {
    const a = parseQualificationSpec({ combinator: 'ANY', pathways: [{ threshold: 2, metric: 'recorded_purchases' }] });
    const b = parseQualificationSpec({ pathways: [{ metric: 'recorded_purchases', threshold: 2 }], combinator: 'ANY' });
    expect(hashSpec(a)).toBe(hashSpec(b));
    expect(hashSpec({ ...a, pathways: [{ ...P, threshold: 3 }] })).not.toBe(hashSpec(a));
  });
});

describe('qualification evaluation (pure, deterministic)', () => {
  const ANY = parseQualificationSpec({ combinator: 'ANY', pathways: [P, R] });
  const ALL = parseQualificationSpec({ combinator: 'ALL', pathways: [P, R] });
  const AT2 = parseQualificationSpec({ combinator: 'AT_LEAST', atLeast: 2, pathways: [P, R, { metric: 'recorded_purchases', threshold: 5 }] });
  it('ANY: one met pathway qualifies', () => { expect(evaluateQualification(ANY, [m(0), m(1)]).qualified).toBe(true); expect(evaluateQualification(ANY, [m(1), m(0)]).qualified).toBe(false); });
  it('ALL: every pathway must be met', () => { expect(evaluateQualification(ALL, [m(2), m(1)]).qualified).toBe(true); expect(evaluateQualification(ALL, [m(2), m(0)]).qualified).toBe(false); });
  it('AT_LEAST n of m', () => { expect(evaluateQualification(AT2, [m(2), m(1), m(0)]).qualified).toBe(true); expect(evaluateQualification(AT2, [m(2), m(0), m(0)]).qualified).toBe(false); });
  it('a missing measure counts as nothing (fail closed) and a failed rule consumes no evidence', () => {
    const o = evaluateQualification(ALL, [m(2), undefined]);
    expect(o.qualified).toBe(false); expect(o.evidenceIds).toEqual([]);
  });
  it('is deterministic and returns the evidence of the met pathways, sorted and de-duplicated', () => {
    const a = evaluateQualification(ALL, [m(2), { observed: 1, evidenceIds: ['e0'] }]);
    expect(a).toEqual(evaluateQualification(ALL, [m(2), { observed: 1, evidenceIds: ['e0'] }]));
    expect(a.evidenceIds).toEqual(['e0', 'e1']);
  });
});
