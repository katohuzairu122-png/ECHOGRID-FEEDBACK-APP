import { describe, expect, it } from 'vitest';
import {
  applyStamp,
  EMPTY_STAMP_STATE,
  stampStateFrom,
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
    expect(byType['LP-04']?.unavailableReason).toBe('IN_DEVELOPMENT');
    expect(isProgramAvailable('LP-99')).toBe(false);
    expect(isProgramAvailable('')).toBe(false);
  });
});

describe('validateProgramConfig', () => {
  it('never validates an unavailable programme', () => {
    expect(validateProgramConfig('LP-08', {}, { currency: 'USD' })).toMatchObject({ ok: false, errors: [{ code: 'PROGRAM_UNAVAILABLE' }] });
    expect(validateProgramConfig('LP-04', {}, { currency: 'USD' })).toMatchObject({ ok: false, errors: [{ code: 'PROGRAM_UNAVAILABLE' }] });
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
    expect(earnForPurchase('LP-04', {}, usd('10.00'))).toEqual({ points: 0, qualifying: false, reason: 'NO_POINTS_PROGRAM' });
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

describe('LP-01 stamp card (pure)', () => {
  const REWARD = '6f0f1c5e-0000-4000-8000-0000000000aa';
  const base = { stampThreshold: 4, rewardId: REWARD, stampExpiryDays: 30, resetPolicy: 'on_completion' as const };
  const at = (iso: string) => new Date(iso);

  it('requires expiry and reset to be stated explicitly, and bounds the threshold', () => {
    expect(validateProgramConfig('LP-01', base, { currency: 'USD' })).toMatchObject({ ok: true });
    expect(validateProgramConfig('LP-01', { ...base, stampExpiryDays: null }, { currency: 'USD' })).toMatchObject({ ok: true });
    const { stampExpiryDays: _omit, ...noExpiry } = base;
    expect(validateProgramConfig('LP-01', noExpiry, { currency: 'USD' })).toMatchObject({ ok: false });
    const { resetPolicy: _omit2, ...noReset } = base;
    expect(validateProgramConfig('LP-01', noReset, { currency: 'USD' })).toMatchObject({ ok: false });
    for (const bad of [{ ...base, stampThreshold: 1 }, { ...base, stampThreshold: 51 }, { ...base, stampThreshold: 4.5 }, { ...base, rewardId: 'not-a-uuid' }, { ...base, stampExpiryDays: 0 }, { ...base, resetPolicy: 'never' }, { ...base, extra: 1 }]) {
      expect(validateProgramConfig('LP-01', bad, { currency: 'USD' }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(validateProgramConfig('LP-01', { ...base, minimumPurchaseAmount: '2' }, { currency: 'USD' })).toMatchObject({ ok: true, config: { minimumPurchaseAmount: '2.00' } });
    expect(validateProgramConfig('LP-01', { ...base, minimumPurchaseAmount: '2.001' }, { currency: 'USD' })).toMatchObject({ ok: false });
  });

  it('the fourth stamp of a four-stamp card completes it, and the card restarts from zero', () => {
    let state = EMPTY_STAMP_STATE;
    const fact = (iso: string) => ({ ...usd('5.00'), now: at(iso) });
    for (const [i, day] of ['2026-01-01', '2026-01-02', '2026-01-03'].entries()) {
      const out = applyStamp(base, state, fact(`${day}T10:00:00Z`));
      expect(out).toMatchObject({ stamped: true, completedCycle: null, expiredStamps: 0 });
      expect(out.state.stamps).toBe(i + 1);
      state = out.state;
    }
    const done = applyStamp(base, state, fact('2026-01-04T10:00:00Z'));
    expect(done).toMatchObject({ stamped: true, completedCycle: 1 });
    expect(done.state).toEqual({ stamps: 0, cycle: 1, cycleStartedAt: null });
    expect(applyStamp(base, done.state, fact('2026-01-05T10:00:00Z')).state).toMatchObject({ stamps: 1, cycle: 1 });
  });

  it('one receipt is one stamp: the engine never adds more than one', () => {
    const out = applyStamp(base, EMPTY_STAMP_STATE, { ...usd('999999.00'), now: at('2026-01-01T00:00:00Z') });
    expect(out.state.stamps).toBe(1);
  });

  it('a receipt below the minimum earns no stamp and changes nothing', () => {
    const cfg = { ...base, minimumPurchaseAmount: '5.00' };
    const out = applyStamp(cfg, EMPTY_STAMP_STATE, { ...usd('4.99'), now: at('2026-01-01T00:00:00Z') });
    expect(out).toMatchObject({ stamped: false, reason: 'BELOW_MINIMUM', state: EMPTY_STAMP_STATE });
  });

  it('an expired card is emptied BEFORE the new receipt counts, and expiry is measured from the first stamp', () => {
    const first = applyStamp(base, EMPTY_STAMP_STATE, { ...usd('5.00'), now: at('2026-01-01T00:00:00Z') });
    const second = applyStamp(base, first.state, { ...usd('5.00'), now: at('2026-01-20T00:00:00Z') });
    expect(second.state.stamps).toBe(2);
    const exactly30 = applyStamp(base, second.state, { ...usd('5.00'), now: at('2026-01-31T00:00:00Z') });
    expect(exactly30).toMatchObject({ expiredStamps: 0 }); // 30 days after the first stamp is still inside the window
    const late = applyStamp(base, second.state, { ...usd('5.00'), now: at('2026-01-31T00:00:01Z') });
    expect(late).toMatchObject({ expiredStamps: 2, stamped: true });
    expect(late.state).toMatchObject({ stamps: 1, cycle: 0, cycleStartedAt: '2026-01-31T00:00:01.000Z' });
  });

  it('with no expiry configured the card never expires', () => {
    const cfg = { ...base, stampExpiryDays: null };
    const first = applyStamp(cfg, EMPTY_STAMP_STATE, { ...usd('5.00'), now: at('2020-01-01T00:00:00Z') });
    expect(applyStamp(cfg, first.state, { ...usd('5.00'), now: at('2030-01-01T00:00:00Z') })).toMatchObject({ expiredStamps: 0 });
  });

  it('reads damaged persisted counters as an empty card, never a bigger one', () => {
    expect(stampStateFrom({ stamps: -3, cycle: 'x', cycleStartedAt: 5 })).toEqual(EMPTY_STAMP_STATE);
    expect(stampStateFrom(null)).toEqual(EMPTY_STAMP_STATE);
    expect(stampStateFrom({ stamps: 2, cycle: 1, cycleStartedAt: '2026-01-01T00:00:00Z' })).toEqual({ stamps: 2, cycle: 1, cycleStartedAt: '2026-01-01T00:00:00Z' });
  });

  it('LP-01 earns no points but still qualifies the receipt', () => {
    expect(earnForPurchase('LP-01', base, usd('5.00'))).toEqual({ points: 0, qualifying: true });
    expect(earnForPurchase('LP-01', { ...base, minimumPurchaseAmount: '9.00' }, usd('5.00'))).toMatchObject({ qualifying: false, reason: 'BELOW_MINIMUM' });
    expect(earnForCheckin('LP-01', base)).toBe(0);
  });
});
