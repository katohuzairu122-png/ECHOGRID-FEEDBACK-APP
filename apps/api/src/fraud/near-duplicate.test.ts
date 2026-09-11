import { describe, it, expect } from 'vitest';
import {
  comparisonTokens,
  jaccardSimilarity,
  isNearDuplicate,
  countNearDuplicates,
  shouldRaiseNearDuplicateSignal,
  nearDuplicateSeverity,
  NEAR_DUPLICATE_MIN_SIMILARITY,
  NEAR_DUPLICATE_SIGNAL_THRESHOLD,
} from './near-duplicate';

/** Similarity of two raw comment strings, the way the detector sees them. */
const similarity = (a: string, b: string) => jaccardSimilarity(comparisonTokens(a), comparisonTokens(b));

describe('comparisonTokens', () => {
  it('strips punctuation, which normalizeFeedbackText deliberately does not', () => {
    // This is the whole reason this tokenizer exists separately. Under the
    // rejected SimHash attempt a punctuation-only difference measured further
    // apart than a real template, purely because the tokens differed.
    expect(similarity('Cold food and slow service, disappointing.', 'COLD food and slow service - disappointing')).toBe(1);
  });

  it('de-duplicates repeated words', () => {
    expect(comparisonTokens('great great great service')).toEqual(new Set(['great', 'service']));
  });

  it('keeps accented letters intact', () => {
    // en/es/fr ship together; stripping accents would give "café" and "cafe"
    // different token sets and quietly mis-score French and Spanish comments.
    expect(comparisonTokens('Café très agréable')).toEqual(new Set(['café', 'très', 'agréable']));
  });

  it('returns an empty set for null, undefined and punctuation-only input', () => {
    expect(comparisonTokens(null).size).toBe(0);
    expect(comparisonTokens(undefined).size).toBe(0);
    expect(comparisonTokens('!!! ... ???').size).toBe(0);
  });
});

describe('jaccardSimilarity', () => {
  it('scores identical token sets 1 and disjoint sets 0', () => {
    expect(similarity('the food was cold', 'the food was cold')).toBe(1);
    expect(similarity('parking impossible', 'delicious pudding')).toBe(0);
  });

  it('scores two empty sets 0, never 1', () => {
    // Scoring them "identical" would make every comment-less submission a
    // near-duplicate of every other comment-less submission.
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'the staff were rude and the table was dirty';
    const b = 'the table was dirty and the staff were rude today';
    expect(similarity(a, b)).toBe(similarity(b, a));
  });

  it('ignores word order, so a shuffled repost still scores 1', () => {
    // Deliberate: shuffling is the cheap evasion. SimHash's order-sensitive
    // bigrams put this pair 15 bits apart, which is why it was rejected.
    expect(similarity('the manager was dismissive and unhelpful', 'unhelpful and dismissive was the manager')).toBe(1);
  });
});

/**
 * The measured pairs from the S5-C investigation, pinned as regression cases.
 * These numbers are the entire argument for the device gate: the honest and
 * attack ranges INVERT, so any future change that tries to raise the
 * threshold into "safe" territory will fail here instead of in production.
 * Full write-up in the project doc `s5c-near-duplicate-finding.md`.
 */
describe('measured similarity of real comment pairs', () => {
  it('scores a template with slots refilled above the threshold', () => {
    const oneSlot = similarity(
      'Great service at Camden, absolutely loved the burger, will be back!',
      'Great service at Oxford, absolutely loved the burger, will be back!',
    );
    const twoSlots = similarity(
      'Great service at Camden, absolutely loved the burger, will be back!',
      'Great service at Oxford, absolutely loved the pizza, will be back!',
    );

    expect(oneSlot).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN_SIMILARITY);
    expect(twoSlots).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN_SIMILARITY);
  });

  it('scores genuinely different comments far below the threshold', () => {
    const sameTopic = similarity(
      'The service here was extremely slow today.',
      'The food arrived cold and the drinks were warm.',
    );
    const unrelated = similarity(
      'Best pizza in town, I will definitely be coming back!',
      'Parking was impossible and the queue went out the door.',
    );

    expect(sameTopic).toBeLessThan(NEAR_DUPLICATE_MIN_SIMILARITY);
    expect(unrelated).toBeLessThan(NEAR_DUPLICATE_MIN_SIMILARITY);
  });

  it('documents the overlap that makes text-only scoring unusable', () => {
    // Two different honest customers, scoring HIGHER than a real template.
    // Without the device gate this pair alone sinks the approach.
    const honest = similarity(
      'The food was great and the service was great.',
      'The service was great and the food was great too.',
    );
    const attack = similarity(
      'Great service at Camden, absolutely loved the burger, will be back!',
      'Great service at Bristol, absolutely loved the pasta, will return!',
    );

    expect(honest).toBeGreaterThan(attack);
    expect(honest).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN_SIMILARITY);
  });
});

describe('countNearDuplicates', () => {
  const TEMPLATE = 'Great service at Camden, absolutely loved the burger, will be back!';

  it('counts only the candidates above the threshold', () => {
    const count = countNearDuplicates(TEMPLATE, [
      'Great service at Oxford, absolutely loved the burger, will be back!', // refilled slot
      'Great service at Bristol, absolutely loved the burger, will be back!', // refilled slot
      'Parking was impossible and the queue went out the door.', // unrelated
    ]);
    expect(count).toBe(2);
  });

  it('returns 0 for a comment-less submission', () => {
    expect(countNearDuplicates(null, [TEMPLATE])).toBe(0);
    expect(countNearDuplicates('', [TEMPLATE])).toBe(0);
  });

  it('skips candidates with no comment rather than matching them', () => {
    expect(countNearDuplicates(TEMPLATE, [null, null])).toBe(0);
  });

  it('counts an exact repost', () => {
    expect(countNearDuplicates(TEMPLATE, [TEMPLATE])).toBe(1);
  });

  it('is threshold-consistent with isNearDuplicate', () => {
    const a = 'The staff were rude and the table was dirty when we arrived.';
    const b = 'The staff were rude and the table was dirty when we arrived today.';
    const expected = isNearDuplicate(comparisonTokens(a), comparisonTokens(b)) ? 1 : 0;
    expect(countNearDuplicates(a, [b])).toBe(expected);
  });
});

describe('shouldRaiseNearDuplicateSignal', () => {
  it('stays silent for a first-time comment', () => {
    expect(shouldRaiseNearDuplicateSignal(0)).toBe(false);
  });

  it('raises at the threshold and above', () => {
    expect(shouldRaiseNearDuplicateSignal(NEAR_DUPLICATE_SIGNAL_THRESHOLD)).toBe(true);
    expect(shouldRaiseNearDuplicateSignal(NEAR_DUPLICATE_SIGNAL_THRESHOLD + 5)).toBe(true);
  });
});

describe('nearDuplicateSeverity', () => {
  it('escalates with the count', () => {
    expect(nearDuplicateSeverity(1)).toBe('low');
    expect(nearDuplicateSeverity(2)).toBe('low');
    expect(nearDuplicateSeverity(3)).toBe('medium');
    expect(nearDuplicateSeverity(7)).toBe('medium');
    expect(nearDuplicateSeverity(8)).toBe('high');
  });

  it('never returns a value outside the fraud_signals severity CHECK constraint', () => {
    const allowed = ['low', 'medium', 'high'];
    for (let count = 0; count <= 30; count++) {
      expect(allowed).toContain(nearDuplicateSeverity(count));
    }
  });

  it('is monotonic', () => {
    const rank = { low: 0, medium: 1, high: 2 };
    let previous = -1;
    for (let count = 0; count <= 30; count++) {
      const current = rank[nearDuplicateSeverity(count)];
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
