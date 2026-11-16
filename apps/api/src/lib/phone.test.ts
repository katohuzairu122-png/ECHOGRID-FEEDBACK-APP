import { describe, expect, it } from 'vitest';
import { normalizeE164 } from './phone';

describe('normalizeE164', () => {
  it('canonicalizes common typed forms', () => {
    expect(normalizeE164('+96566904591')).toBe('+96566904591');
    expect(normalizeE164(' +965 6690-4591 ')).toBe('+96566904591');
    expect(normalizeE164('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizeE164('0096566904591')).toBe('+96566904591');
    expect(normalizeE164('+44.20.7946.0958')).toBe('+442079460958');
  });
  it('never guesses a country: a number without a country code is rejected', () => {
    for (const bad of ['66904591', '0566904591', '(555) 123-4567', '5551234567']) expect(normalizeE164(bad)).toBeNull();
  });
  it('rejects malformed, too short, too long, and non-string input', () => {
    for (const bad of ['', '+', '+0123456789', '+12345', '+1234567890123456', '+1555abc4567', '++15551234567', null, undefined, 15551234567, {}, 'x'.repeat(41)]) {
      expect(normalizeE164(bad as never)).toBeNull();
    }
  });
});
