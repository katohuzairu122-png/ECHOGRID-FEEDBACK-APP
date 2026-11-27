import { describe, expect, it } from 'vitest';
import {
  earnForCheckin,
  earnForPurchase,
  isProgramAvailable,
  parseMoney,
  previewPurchases,
  programRegistry,
  validateProgramConfig,
} from '@echo-grid-feedback/shared-types';
import { computeCheckinEarning, computePurchaseEarning } from './earning';

const usd = (amount: string) => ({ amountMinor: parseMoney(amount, 'USD'), currency: 'USD' });
const kwd = (amount: string) => ({ amountMinor: parseMoney(amount, 'KWD'), currency: 'KWD' });

describe('programme registry', () => {
  it('lists all eight programmes in order and offers only completed ones', () => {
    const registry = programRegistry();
    expect(registry.map((r) => r.type)).toEqual(['LP-01', 'LP-02', 'LP-03', 'LP-04', 'LP-05', 'LP-06', 'LP-07', 'LP-08']);
    for (const entry of registry) {
      expect(entry.available).toBe(isProgramAvailable(entry.type));
      expect(Boolean(entry.unavailableReason)).toBe(!entry.available);
    }
  });
  it('LP-08 is blocked on item-level evidence and the rest wait on development', () => {
    const byType = Object.fromEntries(programRegistry().map((r) => [r.type, r]));
    expect(byType['LP-08']?.unavailableReason).toBe('NEEDS_ITEM_LEVEL_EVIDENCE');
    expect(byType['LP-01']?.unavailableReason).toBe('IN_DEVELOPMENT');
    expect(isProgramAvailable('LP-99')).toBe(false);
    expect(isProgramAvailable('')).toBe(false);
  });
});

describe('validateProgramConfig', () => {
  it('never validates an unavailable programme', () => {
    expect(validateProgramConfig('LP-08', {}, { currency: 'USD' })).toMatchObject({ ok: false, errors: [{ code: 'PROGRAM_UNAVAILABLE' }] });
    expect(validateProgramConfig('LP-01', { threshold: 5 }, { currency: 'USD' })).toMatchObject({ ok: false });
  });
  it('LP-03 normalises the rate and defaults check-in points to none', () => {
    expect(validateProgramConfig('LP-03', { pointsPerCurrencyUnit: ' 1.5 ' }, { currency: 'USD' })).toEqual({
      ok: true,
      config: { pointsPerCurrencyUnit: '1.5', pointsPerCheckin: 0, rounding: 'floor' },
    });
    const r = validateProgramConfig('LP-03', { pointsPerCurrencyUnit: '10', pointsPerCheckin: 5 }, { currency: 'KWD' });
    expect(r).toMatchObject({ ok: true, config: { pointsPerCurrencyUnit: '10', pointsPerCheckin: 5 } });
  });
  it('LP-03 rejects bad rates, unknown fields and out-of-range values', () => {
    for (const bad of [{ pointsPerCurrencyUnit: '1.23456' }, { pointsPerCurrencyUnit: '-1' }, { pointsPerCurrencyUnit: 'abc' }, { pointsPerCurrencyUnit: '100001' }, { pointsPerCurrencyUnit: '1', extra: true }, { pointsPerCurrencyUnit: '1', pointsPerCheckin: -1 }, { pointsPerCurrencyUnit: '1', pointsPerCheckin: 1.5 }, { pointsPerCurrencyUnit: '1', rounding: 'ceil' }, {}]) {
      expect(validateProgramConfig('LP-03', bad, { currency: 'USD' }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
  it('LP-02 validates the minimum against the business currency precision', () => {
    expect(validateProgramConfig('LP-02', { pointsPerPurchase: 10, minimumPurchaseAmount: '5' }, { currency: 'USD' })).toMatchObject({ ok: true, config: { minimumPurchaseAmount: '5.00' } });
    expect(validateProgramConfig('LP-02', { pointsPerPurchase: 10, minimumPurchaseAmount: '1.250' }, { currency: 'KWD' })).toMatchObject({ ok: true, config: { minimumPurchaseAmount: '1.250' } });
    expect(validateProgramConfig('LP-02', { pointsPerPurchase: 10, minimumPurchaseAmount: '1.005' }, { currency: 'USD' })).toMatchObject({ ok: false, errors: [{ path: 'minimumPurchaseAmount', code: 'TOO_MANY_DECIMALS' }] });
    expect(validateProgramConfig('LP-02', { pointsPerPurchase: 10, minimumPurchaseAmount: '0' }, { currency: 'USD' })).toMatchObject({ ok: false });
    for (const bad of [{}, { pointsPerPurchase: 0 }, { pointsPerPurchase: 1.5 }, { pointsPerPurchase: 100_001 }, { pointsPerPurchase: 5, nope: 1 }]) {
      expect(validateProgramConfig('LP-02', bad, { currency: 'USD' }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});

describe('earning (pure)', () => {
  it('LP-03 earns floor(amount x rate) exactly, including a float-trap amount and KWD', () => {
    const cfg = { pointsPerCurrencyUnit: '10', pointsPerCheckin: 0 };
    expect(earnForPurchase('LP-03', cfg, kwd('1.000'))).toEqual({ points: 10, qualifying: true });
    expect(earnForPurchase('LP-03', cfg, kwd('0.999')).points).toBe(9);
    expect(earnForPurchase('LP-03', { pointsPerCurrencyUnit: '100', pointsPerCheckin: 0 }, usd('0.29')).points).toBe(29);
    expect(earnForPurchase('LP-03', { pointsPerCurrencyUnit: '1.5', pointsPerCheckin: 0 }, kwd('3.333')).points).toBe(4);
  });
  it('LP-02 awards a fixed amount regardless of value, honouring an optional minimum', () => {
    const cfg = { pointsPerPurchase: 10, minimumPurchaseAmount: '5.00', pointsPerCheckin: 0 };
    expect(earnForPurchase('LP-02', cfg, usd('5.00'))).toEqual({ points: 10, qualifying: true });
    expect(earnForPurchase('LP-02', cfg, usd('500.00'))).toEqual({ points: 10, qualifying: true });
    expect(earnForPurchase('LP-02', cfg, usd('4.99'))).toEqual({ points: 0, qualifying: false, reason: 'BELOW_MINIMUM' });
    expect(earnForPurchase('LP-02', { pointsPerPurchase: 7, pointsPerCheckin: 0 }, usd('0.01')).points).toBe(7);
  });
  it('fixed points per purchase is distinct from per check-in', () => {
    expect(earnForCheckin('LP-02', { pointsPerPurchase: 10, pointsPerCheckin: 0 })).toBe(0);
    expect(earnForCheckin('LP-02', { pointsPerPurchase: 10, pointsPerCheckin: 3 })).toBe(3);
    expect(earnForCheckin('LP-03', { pointsPerCurrencyUnit: '1', pointsPerCheckin: 5 })).toBe(5);
    expect(earnForCheckin('LP-04', {})).toBe(0);
  });
  it('a programme type without an earning engine earns nothing and is never treated as a points rule', () => {
    expect(earnForPurchase('LP-01', {}, usd('10.00'))).toEqual({ points: 0, qualifying: false, reason: 'NO_POINTS_PROGRAM' });
  });
});

describe('resolution to earning', () => {
  const legacy = { pointsPerCheckin: 10, pointsPerCurrencyUnit: '1.50' };
  it('implicit legacy reproduces the settings exactly with no provenance', () => {
    expect(computePurchaseEarning({ kind: 'implicit_legacy' }, legacy, usd('3.00'))).toEqual({ points: 4, provenance: null });
    expect(computeCheckinEarning({ kind: 'implicit_legacy' }, legacy)).toEqual({ points: 10, provenance: null });
  });
  it('Configure Later earns nothing and never falls back to a default programme', () => {
    expect(computePurchaseEarning({ kind: 'none' }, legacy, usd('99.00'))).toMatchObject({ points: 0, provenance: null });
    expect(computeCheckinEarning({ kind: 'none' }, legacy)).toMatchObject({ points: 0, provenance: null });
  });
  it('an active programme earns under ITS config and records programme and version', () => {
    const resolved = { kind: 'programme' as const, programId: 'p1', version: 3, type: 'LP-02' as const, legacy: false, config: { pointsPerPurchase: 8, pointsPerCheckin: 2 } };
    expect(computePurchaseEarning(resolved, legacy, usd('1.00'))).toEqual({ points: 8, provenance: { programId: 'p1', programVersion: 3 } });
    expect(computeCheckinEarning(resolved, legacy)).toEqual({ points: 2, provenance: { programId: 'p1', programVersion: 3 } });
  });
});

describe('preview uses the same rules as the backend', () => {
  it('gives customer-facing examples and drops samples the currency cannot hold', () => {
    const config = { pointsPerCurrencyUnit: '10', pointsPerCheckin: 0 };
    expect(previewPurchases('LP-03', config, 'KWD', ['1', '2.500', '1.0005'])).toEqual([
      { amount: '1.000', points: 10, qualifying: true },
      { amount: '2.500', points: 25, qualifying: true },
    ]);
  });
});
