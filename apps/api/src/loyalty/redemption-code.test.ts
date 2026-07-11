import { describe, it, expect } from 'vitest';
import { generateRedemptionCode } from './redemption-code';

describe('generateRedemptionCode', () => {
  it('is always 8 characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRedemptionCode()).toHaveLength(8);
    }
  });

  it('never contains visually ambiguous characters (0/O, 1/I/L)', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRedemptionCode()).not.toMatch(/[01IOL]/);
    }
  });

  it('is uppercase alphanumeric only', () => {
    expect(generateRedemptionCode()).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('is not the same value every call (uses real randomness)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateRedemptionCode()));
    expect(codes.size).toBeGreaterThan(45);
  });
});
