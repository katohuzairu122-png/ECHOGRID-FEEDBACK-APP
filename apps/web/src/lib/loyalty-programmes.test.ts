import { describe, expect, it } from 'vitest';
import { validateProgramConfig, type LoyaltyProgramType } from '@echo-grid-feedback/shared-types';
import { buildProgrammeConfig, earningPreview, eligiblePrizeRewards } from './loyalty-programmes';

const R1 = '6f0f1c5e-0000-4000-8000-0000000000a1';
const form = (entries: [string, string][]): FormData => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
const ok = (type: LoyaltyProgramType, config: Record<string, unknown>, currency = 'USD') => validateProgramConfig(type, config, { currency });

describe('buildProgrammeConfig: each programme builds the configuration its own rules accept', () => {
  it('LP-03', () => {
    const config = buildProgrammeConfig('LP-03', form([['pointsPerCurrencyUnit', '10'], ['pointsPerCheckin', '2']]));
    expect(config).toEqual({ pointsPerCurrencyUnit: '10', pointsPerCheckin: 2 });
    expect(ok('LP-03', config, 'KWD')).toMatchObject({ ok: true });
  });
  it('LP-02 keeps the minimum optional and distinct from check-in points', () => {
    const config = buildProgrammeConfig('LP-02', form([['pointsPerPurchase', '10'], ['pointsPerCheckin', '0'], ['minimumPurchaseAmount', '5']]));
    expect(config).toEqual({ pointsPerPurchase: 10, pointsPerCheckin: 0, minimumPurchaseAmount: '5' });
    expect(ok('LP-02', config)).toMatchObject({ ok: true, config: { minimumPurchaseAmount: '5.00' } });
    expect(buildProgrammeConfig('LP-02', form([['pointsPerPurchase', '10'], ['pointsPerCheckin', '0']]))).not.toHaveProperty('minimumPurchaseAmount');
  });
  it('LP-01 states expiry explicitly: never is null, days is a number', () => {
    const never = buildProgrammeConfig('LP-01', form([['stampThreshold', '5'], ['rewardId', R1], ['expiryMode', 'never']]));
    expect(never).toMatchObject({ stampThreshold: 5, stampExpiryDays: null, resetPolicy: 'on_completion' });
    expect(ok('LP-01', never)).toMatchObject({ ok: true });
    const days = buildProgrammeConfig('LP-01', form([['stampThreshold', '5'], ['rewardId', R1], ['expiryMode', 'days'], ['stampExpiryDays', '30']]));
    expect(days).toMatchObject({ stampExpiryDays: 30 });
    expect(ok('LP-01', buildProgrammeConfig('LP-01', form([['stampThreshold', '5'], ['rewardId', R1], ['expiryMode', 'days'], ['stampExpiryDays', '']])))).toMatchObject({ ok: false });
  });
  it('LP-04 reads indexed milestone rows and only applies a minimum to the purchases metric', () => {
    const config = buildProgrammeConfig('LP-04', form([['metric', 'purchases'], ['milestones.0.threshold', '3'], ['milestones.0.rewardId', R1], ['milestones.1.threshold', '5'], ['milestones.1.rewardId', R1], ['minimumPurchaseAmount', '2']]));
    expect((config.milestones as unknown[]).length).toBe(2);
    expect(config.minimumPurchaseAmount).toBe('2');
    expect(ok('LP-04', config)).toMatchObject({ ok: true });
    const spend = buildProgrammeConfig('LP-04', form([['metric', 'spend'], ['milestones.0.threshold', '100'], ['milestones.0.rewardId', R1], ['minimumPurchaseAmount', '2']]));
    expect(spend).not.toHaveProperty('minimumPurchaseAmount');
    expect(ok('LP-04', buildProgrammeConfig('LP-04', form([['metric', 'purchases'], ['milestones.0.threshold', '5'], ['milestones.0.rewardId', R1], ['milestones.1.threshold', '3'], ['milestones.1.rewardId', R1]])))).toMatchObject({ ok: false, errors: [{ code: 'NOT_ASCENDING' }] });
  });
  it('LP-05', () => {
    const config = buildProgrammeConfig('LP-05', form([['period', 'week'], ['requiredPeriods', '4'], ['gracePeriods', '1'], ['evidence', 'purchase'], ['rewardId', R1], ['minimumPurchaseAmount', '3']]));
    expect(config).toMatchObject({ period: 'week', requiredPeriods: 4, gracePeriods: 1, evidence: 'purchase', minimumPurchaseAmount: '3' });
    expect(ok('LP-05', config)).toMatchObject({ ok: true });
    expect(buildProgrammeConfig('LP-05', form([['period', 'day'], ['requiredPeriods', '3'], ['gracePeriods', '0'], ['evidence', 'visit'], ['rewardId', R1], ['minimumPurchaseAmount', '3']]))).not.toHaveProperty('minimumPurchaseAmount');
  });
  it('LP-06 reads window days, times and the multiplier or fixed bonus', () => {
    const config = buildProgrammeConfig('LP-06', form([
      ['pointsPerCurrencyUnit', '1'], ['pointsPerCheckin', '0'],
      ['windows.0.days', '1'], ['windows.0.days', '2'], ['windows.0.start', '14:00'], ['windows.0.end', '17:00'], ['windows.0.mode', 'multiplier'], ['windows.0.value', '2'],
      ['windows.1.days', '6'], ['windows.1.start', '10:00'], ['windows.1.end', '12:00'], ['windows.1.mode', 'bonus'], ['windows.1.value', '5'],
    ]));
    expect(config.windows).toEqual([
      { days: [1, 2], start: '14:00', end: '17:00', multiplier: '2' },
      { days: [6], start: '10:00', end: '12:00', bonusPoints: 5 },
    ]);
    expect(ok('LP-06', config)).toMatchObject({ ok: true });
  });
  it('LP-07 reads indexed mission rows', () => {
    const config = buildProgrammeConfig('LP-07', form([['missions.0.key', 'three-in-seven'], ['missions.0.objective', 'purchases'], ['missions.0.target', '3'], ['missions.0.windowDays', '7'], ['missions.0.rewardId', R1]]));
    expect(config).toEqual({ missions: [{ key: 'three-in-seven', objective: 'purchases', target: '3', windowDays: 7, rewardId: R1 }] });
    expect(ok('LP-07', config)).toMatchObject({ ok: true });
  });
  it('blank or malformed numbers become NaN so the shared rules refuse them with a field error (never a silent default)', () => {
    expect(ok('LP-02', buildProgrammeConfig('LP-02', form([['pointsPerPurchase', ''], ['pointsPerCheckin', '0']])))).toMatchObject({ ok: false });
    expect(ok('LP-02', buildProgrammeConfig('LP-02', form([['pointsPerPurchase', '1.5'], ['pointsPerCheckin', '0']])))).toMatchObject({ ok: false });
    expect(buildProgrammeConfig('LP-08', form([]))).toEqual({});
  });
});

describe('eligiblePrizeRewards', () => {
  const rewards = [
    { id: 'a', type: 'free_item', status: 'active' }, { id: 'b', type: 'points', status: 'active' }, { id: 'c', type: 'voucher', status: 'active' },
    { id: 'd', type: 'discount', status: 'inactive' }, { id: 'e', type: 'discount', status: 'active' },
  ];
  it('LP-01 accepts only active free items; the others also accept active discounts and vouchers; points rewards never', () => {
    expect(eligiblePrizeRewards(rewards, 'LP-01').map((r) => r.id)).toEqual(['a']);
    expect(eligiblePrizeRewards(rewards, 'LP-04').map((r) => r.id)).toEqual(['a', 'c', 'e']);
  });
});

describe('earningPreview uses the backend rules', () => {
  it('shows exact KWD earning for spend and earn and a fixed amount for LP-02', () => {
    const lp03 = earningPreview('LP-03', { pointsPerCurrencyUnit: '10', pointsPerCheckin: 0, rounding: 'floor' }, 'KWD');
    expect(lp03.kind === 'table' && lp03.rows.map((r) => r.points)).toEqual([50, 200, 1000]);
    const lp02 = earningPreview('LP-02', { pointsPerPurchase: 7, minimumPurchaseAmount: '10.00', pointsPerCheckin: 0 }, 'USD');
    expect(lp02.kind === 'table' && lp02.rows.map((r) => [r.points, r.qualifying])).toEqual([[0, false], [7, true], [7, true]]);
    expect(earningPreview('LP-01', { stampThreshold: 5 }, 'USD')).toMatchObject({ kind: 'lines', lines: [{ key: 'lp01', values: { n: 5 } }] });
  });
});
