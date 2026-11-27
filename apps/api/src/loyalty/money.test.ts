import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMoney, minorFromStored, parseMoney, parseRate, percentOf, pointsFor, type MoneyError } from '@echo-grid-feedback/shared-types';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as MoneyError).code;
  }
  return 'NO_ERROR';
};

describe('currency precision', () => {
  it('KWD has three decimals, every other currency two', () => {
    expect(currencyExponent('KWD')).toBe(3);
    for (const c of ['USD', 'EUR', 'GBP', 'SAR', 'AED']) expect(currencyExponent(c)).toBe(2);
  });
  it('rejects a malformed currency code', () => {
    expect(code(() => currencyExponent('kwd'))).toBe('INVALID_CURRENCY');
    expect(code(() => currencyExponent('KWDX'))).toBe('INVALID_CURRENCY');
  });
});

describe('parseMoney', () => {
  it('keeps the third KWD decimal exactly', () => {
    expect(parseMoney('1.001', 'KWD')).toBe(1001n);
    expect(parseMoney('1.005', 'KWD')).toBe(1005n);
    expect(parseMoney('10.999', 'KWD')).toBe(10999n);
    expect(parseMoney(0.3, 'USD')).toBe(30n);
    // A float artefact such as 0.1 + 0.2 is NOT quietly rounded to 0.30: it is refused.
    expect(code(() => parseMoney(0.1 + 0.2, 'USD'))).toMatch(/^(INVALID_FORMAT|TOO_MANY_DECIMALS)$/);
  });
  it('never silently rounds: more digits than the currency allows are rejected', () => {
    expect(code(() => parseMoney('1.0001', 'KWD'))).toBe('TOO_MANY_DECIMALS');
    expect(code(() => parseMoney('1.005', 'USD'))).toBe('TOO_MANY_DECIMALS');
    expect(code(() => parseMoney(1.001, 'USD'))).toBe('TOO_MANY_DECIMALS');
  });
  it('accepts whole and one- or two-digit amounts and pads them', () => {
    expect(parseMoney('9', 'USD')).toBe(900n);
    expect(parseMoney('9.1', 'USD')).toBe(910n);
    expect(parseMoney('9.10', 'USD')).toBe(910n);
    expect(parseMoney('9.1', 'KWD')).toBe(9100n);
  });
  it('rejects zero, negatives, junk, NaN, Infinity, exponent notation and empty input', () => {
    expect(code(() => parseMoney('0', 'USD'))).toBe('NOT_POSITIVE');
    expect(code(() => parseMoney('0.00', 'USD'))).toBe('NOT_POSITIVE');
    expect(code(() => parseMoney('-1', 'USD'))).toBe('NOT_POSITIVE');
    expect(code(() => parseMoney('abc', 'USD'))).toBe('INVALID_FORMAT');
    expect(code(() => parseMoney('', 'USD'))).toBe('INVALID_FORMAT');
    expect(code(() => parseMoney('1e3', 'USD'))).toBe('INVALID_FORMAT');
    expect(code(() => parseMoney(Number.NaN, 'USD'))).toBe('INVALID_FORMAT');
    expect(code(() => parseMoney(Number.POSITIVE_INFINITY, 'USD'))).toBe('INVALID_FORMAT');
    expect(code(() => parseMoney(1e21, 'USD'))).toBe('INVALID_FORMAT');
    expect(code(() => parseMoney('1,5', 'USD'))).toBe('INVALID_FORMAT');
    expect(code(() => parseMoney(' 1.5 ', 'USD'))).toBe('NO_ERROR');
  });
  it('enforces the 1,000,000 maximum in both currencies', () => {
    expect(parseMoney('1000000', 'USD')).toBe(100_000_000n);
    expect(code(() => parseMoney('1000000.01', 'USD'))).toBe('TOO_LARGE');
    expect(parseMoney('1000000.000', 'KWD')).toBe(1_000_000_000n);
    expect(code(() => parseMoney('1000000.001', 'KWD'))).toBe('TOO_LARGE');
    expect(parseMoney('999999.999', 'KWD')).toBe(999_999_999n);
  });
});

describe('formatMoney and stored values', () => {
  it('formats to the currency digits and round-trips', () => {
    expect(formatMoney(910n, 'USD')).toBe('9.10');
    expect(formatMoney(9100n, 'KWD')).toBe('9.100');
    expect(formatMoney(5n, 'KWD')).toBe('0.005');
    expect(formatMoney(5n, 'USD')).toBe('0.05');
    for (const [value, c] of [['0.005', 'KWD'], ['123456.789', 'KWD'], ['0.01', 'USD'], ['999999.99', 'USD']] as const) {
      expect(formatMoney(parseMoney(value, c), c)).toBe(value);
    }
  });
  it('reads database numerics: a legacy 1.10 and a new 1.100 are the same USD amount', () => {
    expect(minorFromStored('1.10', 'USD')).toBe(110n);
    expect(minorFromStored('1.100', 'USD')).toBe(110n);
    expect(minorFromStored('1.001', 'KWD')).toBe(1001n);
    expect(code(() => minorFromStored('1.001', 'USD'))).toBe('TOO_MANY_DECIMALS');
    expect(code(() => minorFromStored('x', 'USD'))).toBe('INVALID_FORMAT');
  });
});

describe('pointsFor (exact floor of amount x rate)', () => {
  it('3.333 KWD at 1.50 points per KWD is 4 points (4.9995 floored)', () => {
    expect(pointsFor(parseMoney('3.333', 'KWD'), 'KWD', parseRate('1.50'))).toBe(4);
  });
  it('lands exactly on an integer and just below it', () => {
    expect(pointsFor(parseMoney('1.000', 'KWD'), 'KWD', parseRate('10'))).toBe(10);
    expect(pointsFor(parseMoney('0.999', 'KWD'), 'KWD', parseRate('10'))).toBe(9);
    expect(pointsFor(parseMoney('0.10', 'USD'), 'USD', parseRate('10'))).toBe(1);
    expect(pointsFor(parseMoney('0.29', 'USD'), 'USD', parseRate('100'))).toBe(29); // 0.29 * 100 is 28.999999999999996 in floating point
  });
  it('handles fractional rates and a zero rate', () => {
    expect(pointsFor(parseMoney('9.99', 'USD'), 'USD', parseRate('0.5'))).toBe(4);
    expect(pointsFor(parseMoney('9.99', 'USD'), 'USD', parseRate('0'))).toBe(0);
  });
  it('rejects bad rates', () => {
    expect(code(() => parseRate('-1'))).toBe('INVALID_RATE');
    expect(code(() => parseRate('1.23456'))).toBe('INVALID_RATE');
    expect(code(() => parseRate('abc'))).toBe('INVALID_RATE');
    expect(code(() => parseRate(1e21))).toBe('INVALID_FORMAT');
  });
  it('matches an independent BigInt reference for random amounts and rates (property test)', () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 2000; i += 1) {
      const currency = i % 2 ? 'KWD' : 'USD';
      const exponent = currencyExponent(currency);
      const minor = BigInt(next() % 100_000_000) + 1n;
      const rateScale = next() % 3;
      const rateNumerator = BigInt(next() % 100_000);
      const rate = { numerator: rateNumerator, scale: rateScale };
      const reference = (minor * rateNumerator) / (10n ** BigInt(exponent + rateScale));
      expect(BigInt(pointsFor(minor, currency, rate))).toBe(reference);
    }
  });
});

describe('percentOf', () => {
  it('rounds down and rejects invalid percentages', () => {
    expect(percentOf(1001n, 1000)).toBe(100n); // 10% of 1.001 KWD = 0.1001 -> 0.100
    expect(percentOf(999n, 5000)).toBe(499n);
    expect(code(() => percentOf(100n, 10_001))).toBe('INVALID_RATE');
    expect(code(() => percentOf(100n, -1))).toBe('INVALID_RATE');
    expect(code(() => percentOf(100n, 0.5))).toBe('INVALID_RATE');
  });
});
