import { describe, it, expect } from 'vitest';
import { normalizeFeedbackText, hashNormalizedText } from './text-normalizer';

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
