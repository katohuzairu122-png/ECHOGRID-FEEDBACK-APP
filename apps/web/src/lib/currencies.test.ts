import { describe, expect, it } from 'vitest';
import { CURRENCY_CODES, getCurrencyOptions } from './currencies';

describe('currency selector catalogue', () => {
  it('contains a broad unique ISO-style catalogue with African and Asian coverage', () => {
    expect(CURRENCY_CODES.length).toBeGreaterThanOrEqual(160);
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
    expect(CURRENCY_CODES.every((code) => /^[A-Z]{3}$/.test(code))).toBe(true);
    expect(CURRENCY_CODES).toEqual(
      expect.arrayContaining([
        'UGX',
        'KES',
        'NGN',
        'GHS',
        'XAF',
        'XOF',
        'ZAR',
        'KWD',
        'AED',
        'SAR',
        'INR',
        'CNY',
        'JPY',
        'IDR',
        'PHP',
        'THB',
        'VND',
      ]),
    );
  });

  it('localizes display names and preserves an existing uncommon code', () => {
    const english = getCurrencyOptions('en', 'ZZZ');
    const arabic = getCurrencyOptions('ar');

    expect(english.find(({ code }) => code === 'UGX')?.label).toContain('Ugandan Shilling');
    expect(arabic.find(({ code }) => code === 'KWD')?.label).not.toBe('KWD');
    expect(english.find(({ code }) => code === 'ZZZ')).toEqual({ code: 'ZZZ', label: 'ZZZ' });
  });
});
