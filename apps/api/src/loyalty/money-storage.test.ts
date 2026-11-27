import { beforeEach, describe, expect, it } from 'vitest';
import { fromMilli, milliToNumber, moneyStorageScale, resetMoneyStorageScaleCache, toMilli } from './money-storage';

describe('exact thousandths (LPC-14)', () => {
  it('round-trips text without a floating-point step', () => {
    for (const text of ['0.001', '0.333', '12.345', '99999999.999', '5.000']) expect(fromMilli(toMilli(text), 3)).toBe(text.includes('.') ? text : `${text}.000`);
    expect(fromMilli(toMilli('12.5'), 2)).toBe('12.50');
    expect(fromMilli(toMilli('12'), 0)).toBe('12');
  });
  it('refuses to format with fewer decimals than the amount needs (never rounds)', () => {
    expect(() => fromMilli(toMilli('8.305'), 2)).toThrow(/decimal places/);
    expect(() => fromMilli(toMilli('8.5'), 0)).toThrow();
  });
  it('sums and multiplies exactly where doubles drift', () => {
    expect(toMilli('0.1') + toMilli('0.2')).toBe(toMilli('0.3'));
    expect(3n * toMilli('9.10')).toBe(toMilli('27.3'));
    expect(milliToNumber(3n * toMilli('9.10'))).toBe(27.3);
  });
});

const typmod = (precision: number, scale: number) => (precision << 16) + scale + 4;
const fakeDb = (mods: (number | null)[]) => {
  let i = 0;
  return { execute: async () => ({ rows: [{ atttypmod: mods[i++] }] }) } as never;
};

describe('moneyStorageScale reads the catalogue (safe in either deploy order)', () => {
  beforeEach(() => resetMoneyStorageScaleCache());
  it('is 2 while any money column is still numeric(10,2), and 3 once all are numeric(11,3)', async () => {
    expect(await moneyStorageScale(fakeDb([typmod(10, 2), typmod(10, 2), typmod(10, 2), typmod(10, 2)]), 0)).toBe(2);
    resetMoneyStorageScaleCache();
    expect(await moneyStorageScale(fakeDb([typmod(11, 3), typmod(11, 3), typmod(11, 3), typmod(11, 3)]), 0)).toBe(3);
  });
  it('is the SMALLEST scale among the columns, so a half-applied change never allows a third decimal', async () => {
    expect(await moneyStorageScale(fakeDb([typmod(11, 3), typmod(11, 3), typmod(10, 2), typmod(11, 3)]), 0)).toBe(2);
  });
  it('treats an unconstrained numeric as three decimals and caches for a minute', async () => {
    expect(await moneyStorageScale(fakeDb([-1, -1, -1, -1]), 0)).toBe(3);
    expect(await moneyStorageScale(fakeDb([typmod(10, 2), typmod(10, 2), typmod(10, 2), typmod(10, 2)]), 30_000)).toBe(3);
    expect(await moneyStorageScale(fakeDb([typmod(10, 2), typmod(10, 2), typmod(10, 2), typmod(10, 2)]), 61_000)).toBe(2);
  });
});
