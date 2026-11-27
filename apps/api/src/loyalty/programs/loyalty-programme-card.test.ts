import { describe, expect, it } from 'vitest';
import { programmeCardView } from '@echo-grid-feedback/shared-types';

const now = new Date('2026-06-10T12:00:00Z');
const reward = '6f0f1c5e-0000-4000-8000-000000000001';

describe('programmeCardView (LPC-07)', () => {
  it('points programmes have no extra progress', () => {
    expect(programmeCardView('LP-03', {}, {}, 'USD', now)).toEqual({ kind: 'points', type: 'LP-03' });
    expect(programmeCardView('LP-02', {}, {}, 'USD', now)).toEqual({ kind: 'points', type: 'LP-02' });
  });

  it('LP-01 shows stamps toward the threshold and hides stamps that have expired', () => {
    const config = { stampThreshold: 5, rewardId: reward, stampExpiryDays: 30, resetPolicy: 'on_completion' };
    const live = programmeCardView('LP-01', config, { stamps: 2, cycle: 1, cycleStartedAt: '2026-06-01T00:00:00Z' }, 'USD', now);
    expect(live).toMatchObject({ kind: 'stamps', stamps: 2, threshold: 5, completedCards: 1, expired: false, fraction: 0.4, expiresAt: '2026-07-01T00:00:00.000Z' });
    const old = programmeCardView('LP-01', config, { stamps: 2, cycle: 0, cycleStartedAt: '2026-04-01T00:00:00Z' }, 'USD', now);
    expect(old).toMatchObject({ stamps: 0, expired: true, expiresAt: null, fraction: 0 });
    const never = programmeCardView('LP-01', { ...config, stampExpiryDays: null }, { stamps: 1, cycleStartedAt: '2020-01-01T00:00:00Z' }, 'USD', now);
    expect(never).toMatchObject({ stamps: 1, expired: false, expiresAt: null });
  });

  it('an empty or unexpected counters object is an empty card, never a larger one', () => {
    const config = { stampThreshold: 3, rewardId: reward, stampExpiryDays: null, resetPolicy: 'on_completion' };
    expect(programmeCardView('LP-01', config, { stamps: 'lots' }, 'USD', now)).toMatchObject({ stamps: 0, fraction: 0 });
    expect(programmeCardView('LP-01', config, null, 'USD', now)).toMatchObject({ stamps: 0 });
  });

  it('LP-04 reports the ladder, what is achieved and progress to the next rung (exact KWD spend)', () => {
    const config = { metric: 'spend', milestones: [{ threshold: '10.000', rewardId: reward }, { threshold: '30.000', rewardId: 'b' }] };
    const view = programmeCardView('LP-04', config, { spendMinor: 20_000, achieved: [reward] }, 'KWD', now);
    expect(view).toMatchObject({ kind: 'milestones', metric: 'spend', current: '20.000' });
    expect((view as { ladder: { achieved: boolean }[] }).ladder.map((m) => m.achieved)).toEqual([true, false]);
    expect((view as { fraction: number }).fraction).toBe(0.5);
    const done = programmeCardView('LP-04', { metric: 'purchases', milestones: [{ threshold: '3', rewardId: reward }] }, { count: 5, achieved: [reward] }, 'USD', now);
    expect(done).toMatchObject({ current: '5', fraction: 1 });
  });

  it('LP-05 shows the streak against the required periods', () => {
    const view = programmeCardView('LP-05', { period: 'week', requiredPeriods: 4, gracePeriods: 1, evidence: 'visit', rewardId: reward }, { streak: 3, cycle: 2, lastPeriod: 10 }, 'USD', now);
    expect(view).toMatchObject({ kind: 'streak', period: 'week', streak: 3, required: 4, completedStreaks: 2, fraction: 0.75 });
  });

  it('LP-06 exposes only the public terms: windows and effective dates', () => {
    const view = programmeCardView('LP-06', { pointsPerCurrencyUnit: '1', windows: [{ days: [1, 2], start: '14:00', end: '16:00', multiplier: '2' }], effectiveUntil: '2026-12-31' }, {}, 'USD', now);
    expect(view).toEqual({ kind: 'offpeak', windows: [{ days: [1, 2], start: '14:00', end: '16:00', multiplier: '2' }], effectiveFrom: null, effectiveUntil: '2026-12-31' });
  });

  it('LP-07 reports each mission: not started, active with its end, completed, and expired', () => {
    const config = { missions: [
      { key: 'a', objective: 'purchases', target: '3', windowDays: 10, rewardId: reward },
      { key: 'b', objective: 'spend', target: '50.00', windowDays: 10, rewardId: reward },
      { key: 'c', objective: 'visits', target: '2', windowDays: 5, rewardId: reward },
      { key: 'd', objective: 'visits', target: '2', windowDays: 5, rewardId: reward },
    ] };
    const counters = { missions: {
      a: { startedAt: '2026-06-08T00:00:00Z', count: 1, spendMinor: 0, status: 'active' },
      b: { startedAt: '2026-06-08T00:00:00Z', count: 0, spendMinor: 2_500, status: 'completed' },
      c: { startedAt: '2026-05-01T00:00:00Z', count: 1, spendMinor: 0, status: 'active' },
    } };
    const view = programmeCardView('LP-07', config, counters, 'USD', now);
    const m = (view as { missions: { key: string; status: string; fraction: number; endsAt: string | null; current: string }[] }).missions;
    expect(m.map((x) => x.status)).toEqual(['active', 'completed', 'expired', 'not_started']);
    expect(m[0]).toMatchObject({ endsAt: '2026-06-18T00:00:00.000Z', fraction: 1 / 3, current: '1' });
    expect(m[1]).toMatchObject({ fraction: 1, endsAt: null });
    expect(m[2]).toMatchObject({ fraction: 0, current: '0', endsAt: null });
  });

  it('never carries an owner, cashier or other-customer field', () => {
    const view = JSON.stringify(programmeCardView('LP-01', { stampThreshold: 3, rewardId: reward, stampExpiryDays: null, resetPolicy: 'on_completion' }, { stamps: 1 }, 'USD', now));
    expect(view).not.toMatch(/customerId|userId|businessId|loyaltyAccountId/);
  });
});
