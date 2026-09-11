import { describe, it, expect } from 'vitest';
import {
  normalizeFeedbackText,
  hashNormalizedText,
  isDistinctiveEnoughToCompare,
  MIN_DISTINCTIVE_LENGTH,
} from './text-normalizer';

describe('normalizeFeedbackText', () => {
  it('returns null for null, undefined, and whitespace-only input', () => {
    expect(normalizeFeedbackText(null)).toBeNull();
    expect(normalizeFeedbackText(undefined)).toBeNull();
    expect(normalizeFeedbackText('   ')).toBeNull();
    expect(normalizeFeedbackText('\n\t  \n')).toBeNull();
  });

  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeFeedbackText('  Great Service!  ')).toBe('great service!');
    expect(normalizeFeedbackText('Cold   food\n\nand slow  service')).toBe('cold food and slow service');
  });

  it('treats formatting-only differences as equal after normalization', () => {
    const a = normalizeFeedbackText('The food was cold.');
    const b = normalizeFeedbackText('  the FOOD was   cold.  ');
    expect(a).toBe(b);
  });

  it('does not collapse genuinely different text to the same value', () => {
    expect(normalizeFeedbackText('Great service')).not.toBe(normalizeFeedbackText('Terrible service'));
  });
});

describe('hashNormalizedText', () => {
  it('is deterministic for the same input', async () => {
    const a = await hashNormalizedText('cold food and slow service');
    const b = await hashNormalizedText('cold food and slow service');
    expect(a).toBe(b);
  });

  it('produces different hashes for different input', async () => {
    const a = await hashNormalizedText('cold food');
    const b = await hashNormalizedText('great food');
    expect(a).not.toBe(b);
  });

  it('produces a 64-character lowercase hex SHA-256 digest', async () => {
    const hash = await hashNormalizedText('sample text');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** Continuing Development S5-A -- spec S5.6's "protection against rejecting
 * legitimate short common phrases". */
describe('isDistinctiveEnoughToCompare', () => {
  it('rejects null', () => {
    expect(isDistinctiveEnoughToCompare(null)).toBe(false);
  });

  it('is inclusive at exactly the floor and false one character below', () => {
    // Pinned to the constant rather than a literal, so retuning the floor
    // from real data changes one number and not the test's meaning.
    expect(isDistinctiveEnoughToCompare('x'.repeat(MIN_DISTINCTIVE_LENGTH))).toBe(true);
    expect(isDistinctiveEnoughToCompare('x'.repeat(MIN_DISTINCTIVE_LENGTH - 1))).toBe(false);
  });

  it('rejects the short pleasantries two honest customers genuinely both write', () => {
    // The actual failure this exists to prevent: before S5-A, the second
    // customer to write any of these was flagged as a duplicate.
    for (const phrase of ['great service', 'very good', 'loved it', 'ok', 'lovely, thanks', 'best pizza!']) {
      expect(isDistinctiveEnoughToCompare(normalizeFeedbackText(phrase))).toBe(false);
    }
  });

  it('accepts text long enough that an exact repeat is actually evidence', () => {
    for (const phrase of [
      'Cold food and slow service.',
      'The staff were rude and the table was dirty.',
      'Best pizza in town, I will definitely be coming back!',
    ]) {
      expect(isDistinctiveEnoughToCompare(normalizeFeedbackText(phrase))).toBe(true);
    }
  });

  it('measures the normalized form, not the raw input', () => {
    // Padding is not distinctiveness -- a short phrase surrounded by
    // whitespace must not sneak over the floor on raw length.
    const padded = `   ${'  '.repeat(20)}great   service   `;
    expect(padded.length).toBeGreaterThan(MIN_DISTINCTIVE_LENGTH);
    expect(isDistinctiveEnoughToCompare(normalizeFeedbackText(padded))).toBe(false);
  });
});
