import { describe, expect, it } from 'vitest';
import {
  applyMilestone,
  applyMissions,
  applyStreak,
  EMPTY_MILESTONE_STATE,
  EMPTY_MISSION_STATE,
  EMPTY_STREAK_STATE,
  earnOffPeak,
  isValidTimeZone,
  localTimeOf,
  milestoneStateFrom,
  missionStateFrom,
  parseMoney,
  periodIndexOf,
  streakStateFrom,
  validateLp04,
  validateLp05,
  validateLp06,
  validateLp07,
  validateProgramConfig,
  type ProgressEvent,
} from '@echo-grid-feedback/shared-types';

const R1 = '6f0f1c5e-0000-4000-8000-0000000000a1';
const R2 = '6f0f1c5e-0000-4000-8000-0000000000a2';
const buy = (amount: string, iso: string, currency = 'USD'): ProgressEvent => ({ kind: 'purchase', amountMinor: parseMoney(amount, currency), currency, occurredAt: new Date(iso) });
const visit = (iso: string): ProgressEvent => ({ kind: 'visit', occurredAt: new Date(iso) });

describe('business-local time', () => {
  it('Kuwait is three hours ahead: 22:30 UTC is already the next local day', () => {
    expect(localTimeOf(new Date('2026-06-10T22:30:00Z'), 'Asia/Kuwait')).toMatchObject({ date: '2026-06-11', minutes: 1 * 60 + 30 });
    expect(localTimeOf(new Date('2026-06-10T20:59:59Z'), 'Asia/Kuwait').date).toBe('2026-06-10');
    expect(localTimeOf(new Date('2026-06-10T21:00:00Z'), 'Asia/Kuwait').date).toBe('2026-06-11');
  });
  it('handles the daylight-saving spring-forward and fall-back days in New York', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 (EST to EDT). The local day is still one calendar date throughout.
    expect(localTimeOf(new Date('2026-03-08T06:59:00Z'), 'America/New_York')).toMatchObject({ date: '2026-03-08', minutes: 1 * 60 + 59 });
    expect(localTimeOf(new Date('2026-03-08T07:00:00Z'), 'America/New_York')).toMatchObject({ date: '2026-03-08', minutes: 3 * 60 });
    const before = localTimeOf(new Date('2026-03-08T04:59:59Z'), 'America/New_York');
    const after = localTimeOf(new Date('2026-03-09T03:59:59Z'), 'America/New_York');
    expect(after.dayNumber - before.dayNumber).toBe(1); // consecutive local days even across the 23-hour day
    // 2026-11-01: 01:00-02:00 happens twice (EDT then EST) but each instant has exactly one reading.
    expect(localTimeOf(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toMatchObject({ date: '2026-11-01', minutes: 60 + 30 });
    expect(localTimeOf(new Date('2026-11-01T06:30:00Z'), 'America/New_York')).toMatchObject({ date: '2026-11-01', minutes: 60 + 30 });
  });
  it('weekday and week index are Monday-based and stable', () => {
    expect(localTimeOf(new Date('2026-11-23T12:00:00Z'), 'UTC').weekday).toBe(1); // a Monday
    expect(localTimeOf(new Date('2026-11-29T12:00:00Z'), 'UTC').weekday).toBe(7);
    const mon = periodIndexOf(localTimeOf(new Date('2026-11-23T00:00:00Z'), 'UTC'), 'week');
    expect(periodIndexOf(localTimeOf(new Date('2026-11-29T23:59:59Z'), 'UTC'), 'week')).toBe(mon);
    expect(periodIndexOf(localTimeOf(new Date('2026-11-30T00:00:00Z'), 'UTC'), 'week')).toBe(mon + 1);
  });
  it('recognises real time zones only', () => {
    expect(isValidTimeZone('Asia/Kuwait')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('LP-04 milestones', () => {
  const cfg = (metric: string, extra: Record<string, unknown> = {}) => ({ metric, milestones: [{ threshold: '3', rewardId: R1 }, { threshold: '5', rewardId: R2 }], ...extra });
  it('validates ascending thresholds, whole-number counts and exact spend amounts', () => {
    expect(validateLp04(cfg('purchases'), 'USD')).toMatchObject({ ok: true, rewardIds: [R1, R2] });
    expect(validateLp04({ metric: 'purchases', milestones: [{ threshold: '5', rewardId: R1 }, { threshold: '3', rewardId: R2 }] }, 'USD')).toMatchObject({ ok: false, errors: [{ code: 'NOT_ASCENDING' }] });
    expect(validateLp04({ metric: 'purchases', milestones: [{ threshold: '3', rewardId: R1 }, { threshold: '3', rewardId: R2 }] }, 'USD')).toMatchObject({ ok: false });
    expect(validateLp04({ metric: 'visits', milestones: [{ threshold: '2.5', rewardId: R1 }] }, 'USD')).toMatchObject({ ok: false });
    expect(validateLp04({ metric: 'spend', milestones: [{ threshold: '100', rewardId: R1 }, { threshold: '250.5', rewardId: R2 }] }, 'USD')).toMatchObject({ ok: true, config: { milestones: [{ threshold: '100.00' }, { threshold: '250.50' }] } });
    expect(validateLp04({ metric: 'spend', milestones: [{ threshold: '10.001', rewardId: R1 }] }, 'USD')).toMatchObject({ ok: false });
    expect(validateLp04({ metric: 'tier', milestones: [{ threshold: '1', rewardId: R1 }] }, 'USD')).toMatchObject({ ok: false });
    expect(validateLp04({ ...cfg('purchases'), tierUpgrade: true }, 'USD')).toMatchObject({ ok: false }); // a milestone is not a tier upgrade
    expect(validateLp04({ metric: 'purchases', milestones: [] }, 'USD')).toMatchObject({ ok: false });
  });
  it('awards each milestone once when its purchase count is reached, and never again', () => {
    const config = (validateLp04(cfg('purchases'), 'USD') as { config: Record<string, unknown> }).config;
    let state = EMPTY_MILESTONE_STATE;
    const grants: string[] = [];
    for (let i = 1; i <= 8; i += 1) {
      const out = applyMilestone(config, state, buy('5.00', `2026-01-0${i}T10:00:00Z`));
      state = out.state;
      grants.push(...out.grants.map((g) => g.key));
    }
    expect(grants).toEqual(['milestone:3', 'milestone:5']);
    expect(state).toMatchObject({ count: 8 });
  });
  it('counts check-ins only for the visits metric and receipts only for purchases', () => {
    const visits = (validateLp04(cfg('visits'), 'USD') as { config: Record<string, unknown> }).config;
    expect(applyMilestone(visits, EMPTY_MILESTONE_STATE, buy('5.00', '2026-01-01T10:00:00Z')).reason).toBe('EVENT_NOT_COUNTED');
    expect(applyMilestone(visits, EMPTY_MILESTONE_STATE, visit('2026-01-01T10:00:00Z')).state.count).toBe(1);
    const purchases = (validateLp04(cfg('purchases', { minimumPurchaseAmount: '5' }), 'USD') as { config: Record<string, unknown> }).config;
    expect(applyMilestone(purchases, EMPTY_MILESTONE_STATE, visit('2026-01-01T10:00:00Z')).reason).toBe('EVENT_NOT_COUNTED');
    expect(applyMilestone(purchases, EMPTY_MILESTONE_STATE, buy('4.99', '2026-01-01T10:00:00Z')).reason).toBe('BELOW_MINIMUM');
  });
  it('spend milestones accumulate exact amounts (KWD three decimals) and one big purchase can cross several', () => {
    const config = (validateLp04({ metric: 'spend', milestones: [{ threshold: '10.000', rewardId: R1 }, { threshold: '25.500', rewardId: R2 }] }, 'KWD') as { config: Record<string, unknown> }).config;
    let out = applyMilestone(config, EMPTY_MILESTONE_STATE, buy('9.999', '2026-01-01T10:00:00Z', 'KWD'));
    expect(out.grants).toEqual([]);
    out = applyMilestone(config, out.state, buy('0.001', '2026-01-02T10:00:00Z', 'KWD'));
    expect(out.grants.map((g) => g.key)).toEqual(['milestone:10.000']);
    out = applyMilestone(config, EMPTY_MILESTONE_STATE, buy('30.000', '2026-01-03T10:00:00Z', 'KWD'));
    expect(out.grants.map((g) => g.key)).toEqual(['milestone:10.000', 'milestone:25.500']);
  });
  it('reads damaged counters as empty', () => {
    expect(milestoneStateFrom({ count: -1, spendMinor: 'x', achieved: [1, 'a'] })).toEqual({ count: 0, spendMinor: 0, achieved: ['a'] });
  });
});

describe('LP-05 streaks (business-local)', () => {
  const base = { period: 'day', requiredPeriods: 3, gracePeriods: 0, evidence: 'visit', rewardId: R1 };
  const config = (extra: Record<string, unknown> = {}) => (validateLp05({ ...base, ...extra }, 'USD') as { config: Record<string, unknown> }).config;
  it('validates bounds and evidence-specific fields', () => {
    expect(validateLp05(base, 'USD')).toMatchObject({ ok: true, rewardIds: [R1] });
    for (const bad of [{ ...base, requiredPeriods: 1 }, { ...base, gracePeriods: 4 }, { ...base, period: 'month' }, { ...base, evidence: 'review' }, { ...base, minimumPurchaseAmount: '5' }, { ...base, extra: 1 }]) {
      expect(validateLp05(bad, 'USD'), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(validateLp05({ ...base, evidence: 'purchase', minimumPurchaseAmount: '5' }, 'USD')).toMatchObject({ ok: true, config: { minimumPurchaseAmount: '5.00' } });
  });
  it('three consecutive local days complete the streak; several visits in one day count once', () => {
    const c = config();
    let state = EMPTY_STREAK_STATE;
    for (const iso of ['2026-05-01T09:00:00Z', '2026-05-01T18:00:00Z']) state = applyStreak(c, state, visit(iso), 'UTC').state;
    expect(state.streak).toBe(1);
    state = applyStreak(c, state, visit('2026-05-02T09:00:00Z'), 'UTC').state;
    const done = applyStreak(c, state, visit('2026-05-03T09:00:00Z'), 'UTC');
    expect(done.grants).toEqual([{ key: 'streak:1', rewardId: R1 }]);
    expect(done.state).toMatchObject({ streak: 0, cycle: 1 });
    expect(applyStreak(c, done.state, visit('2026-05-03T20:00:00Z'), 'UTC').steps).toEqual([]); // same day as the completion: nothing new
    expect(applyStreak(c, done.state, visit('2026-05-04T09:00:00Z'), 'UTC').state.streak).toBe(1);
  });
  it('uses the business-local day, not the UTC day, at midnight', () => {
    const c = config();
    // 21:30 UTC on 1 May is 00:30 on 2 May in Kuwait: that visit and 08:00 UTC the same morning are the SAME local day.
    let state = applyStreak(c, EMPTY_STREAK_STATE, visit('2026-05-01T21:30:00Z'), 'Asia/Kuwait').state;
    expect(applyStreak(c, state, visit('2026-05-02T08:00:00Z'), 'Asia/Kuwait').reason).toBe('SAME_PERIOD');
    // The same two instants in UTC are different days.
    state = applyStreak(c, EMPTY_STREAK_STATE, visit('2026-05-01T21:30:00Z'), 'UTC').state;
    expect(applyStreak(c, state, visit('2026-05-02T08:00:00Z'), 'UTC').state.streak).toBe(2);
  });
  it('stays correct across the daylight-saving 23-hour day', () => {
    const c = config();
    let state = applyStreak(c, EMPTY_STREAK_STATE, visit('2026-03-07T20:00:00-05:00'), 'America/New_York').state;
    state = applyStreak(c, state, visit('2026-03-08T20:00:00-04:00'), 'America/New_York').state; // the short day
    const done = applyStreak(c, state, visit('2026-03-09T09:00:00-04:00'), 'America/New_York');
    expect(done.grants).toHaveLength(1);
  });
  it('a missed day breaks the streak unless grace allows it; a late replay changes nothing', () => {
    const strict = config();
    let state = applyStreak(strict, EMPTY_STREAK_STATE, visit('2026-05-01T09:00:00Z'), 'UTC').state;
    state = applyStreak(strict, state, visit('2026-05-02T09:00:00Z'), 'UTC').state;
    const broken = applyStreak(strict, state, visit('2026-05-04T09:00:00Z'), 'UTC'); // day 3 missed
    expect(broken.state.streak).toBe(1);
    expect(broken.steps.map((s) => s.kind)).toContain('streak_broken');
    const graceful = config({ gracePeriods: 1 });
    state = applyStreak(graceful, EMPTY_STREAK_STATE, visit('2026-05-01T09:00:00Z'), 'UTC').state;
    state = applyStreak(graceful, state, visit('2026-05-02T09:00:00Z'), 'UTC').state;
    expect(applyStreak(graceful, state, visit('2026-05-04T09:00:00Z'), 'UTC').grants).toHaveLength(1); // one missed day tolerated
    expect(applyStreak(strict, state, visit('2026-05-01T08:00:00Z'), 'UTC').reason).toBe('OUT_OF_ORDER');
  });
  it('weekly streaks count local ISO weeks and ignore the wrong kind of evidence', () => {
    const c = config({ period: 'week', requiredPeriods: 2, evidence: 'purchase' });
    let out = applyStreak(c, EMPTY_STREAK_STATE, buy('5.00', '2026-11-23T10:00:00Z'), 'UTC'); // Monday
    out = applyStreak(c, out.state, buy('5.00', '2026-11-29T10:00:00Z'), 'UTC'); // Sunday of the same week
    expect(out.reason).toBe('SAME_PERIOD');
    out = applyStreak(c, out.state, buy('5.00', '2026-11-30T00:00:00Z'), 'UTC'); // next Monday
    expect(out.grants).toHaveLength(1);
    expect(applyStreak(c, EMPTY_STREAK_STATE, visit('2026-11-23T10:00:00Z'), 'UTC').reason).toBe('EVENT_NOT_COUNTED');
  });
  it('reads damaged counters as an empty streak', () => {
    expect(streakStateFrom({ streak: -1, cycle: 'x', lastPeriod: 1.5 })).toEqual(EMPTY_STREAK_STATE);
  });
});

describe('LP-06 off-peak', () => {
  const lp06 = (extra: Record<string, unknown> = {}) => ({ pointsPerCurrencyUnit: '1', windows: [{ days: [1, 2, 3, 4, 5], start: '14:00', end: '17:00', multiplier: '2' }], ...extra });
  const config = (extra: Record<string, unknown> = {}) => (validateLp06(lp06(extra)) as { config: Record<string, unknown> }).config;
  it('validates windows: end after start, no overlap on a day, exactly one of multiplier or bonus, sane bounds', () => {
    expect(validateLp06(lp06())).toMatchObject({ ok: true });
    for (const bad of [
      lp06({ windows: [{ days: [1], start: '17:00', end: '14:00', multiplier: '2' }] }),
      lp06({ windows: [{ days: [1], start: '14:00', end: '14:00', multiplier: '2' }] }),
      lp06({ windows: [{ days: [1], start: '14:00', end: '17:00', multiplier: '2' }, { days: [1, 2], start: '16:59', end: '18:00', bonusPoints: 5 }] }),
      lp06({ windows: [{ days: [1], start: '14:00', end: '17:00' }] }),
      lp06({ windows: [{ days: [1], start: '14:00', end: '17:00', multiplier: '2', bonusPoints: 5 }] }),
      lp06({ windows: [{ days: [1], start: '14:00', end: '17:00', multiplier: '0.5' }] }),
      lp06({ windows: [{ days: [1], start: '14:00', end: '17:00', multiplier: '11' }] }),
      lp06({ windows: [{ days: [8], start: '14:00', end: '17:00', multiplier: '2' }] }),
      lp06({ windows: [{ days: [1], start: '25:00', end: '26:00', multiplier: '2' }] }),
      lp06({ effectiveFrom: '2026-02-01', effectiveUntil: '2026-01-01' }),
    ]) {
      expect(validateLp06(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    // Adjacent windows (end == next start) do not overlap.
    expect(validateLp06(lp06({ windows: [{ days: [1], start: '14:00', end: '15:00', multiplier: '2' }, { days: [1], start: '15:00', end: '17:00', bonusPoints: 3 }] }))).toMatchObject({ ok: true });
  });
  it('applies the multiplier only inside the window in BUSINESS-LOCAL time; the end minute is excluded', () => {
    const c = config();
    const amount = parseMoney('10.00', 'USD');
    const at = (iso: string) => earnOffPeak(c, amount, 'USD', new Date(iso), 'America/New_York');
    expect(at('2026-11-23T19:00:00Z')).toMatchObject({ points: 20, window: '1,2,3,4,5 14:00-17:00' }); // Monday 14:00 EST
    expect(at('2026-11-23T21:59:00Z').points).toBe(20); // 16:59 local
    expect(at('2026-11-23T22:00:00Z').points).toBe(10); // 17:00 local: outside
    expect(at('2026-11-23T18:59:00Z').points).toBe(10); // 13:59 local
    expect(at('2026-11-28T19:00:00Z').points).toBe(10); // Saturday: no window
    // The same UTC instant is peak in one timezone and off-peak in another.
    expect(earnOffPeak(c, amount, 'USD', new Date('2026-11-23T19:00:00Z'), 'Asia/Kuwait').points).toBe(10); // 22:00 local
  });
  it('uses exact arithmetic: floor of amount x rate x multiplier, and a fixed bonus adds to the base', () => {
    const mult = config({ pointsPerCurrencyUnit: '1.5', windows: [{ days: [1], start: '00:00', end: '23:59', multiplier: '1.5' }] });
    expect(earnOffPeak(mult, parseMoney('3.333', 'KWD'), 'KWD', new Date('2026-11-23T10:00:00Z'), 'UTC').points).toBe(7); // floor(3.333 x 1.5 x 1.5 = 7.49925)
    const bonus = config({ windows: [{ days: [1], start: '00:00', end: '23:59', bonusPoints: 5 }] });
    expect(earnOffPeak(bonus, parseMoney('3.00', 'USD'), 'USD', new Date('2026-11-23T10:00:00Z'), 'UTC')).toMatchObject({ basePoints: 3, bonusPoints: 5, points: 8 });
  });
  it('honours effective dates in local calendar days, inclusive', () => {
    const c = config({ effectiveFrom: '2026-11-24', effectiveUntil: '2026-11-25' });
    const amount = parseMoney('10.00', 'USD');
    expect(earnOffPeak(c, amount, 'USD', new Date('2026-11-23T15:00:00Z'), 'UTC').points).toBe(10); // Monday 23rd: before
    expect(earnOffPeak(c, amount, 'USD', new Date('2026-11-24T15:00:00Z'), 'UTC').points).toBe(20);
    expect(earnOffPeak(c, amount, 'USD', new Date('2026-11-25T15:00:00Z'), 'UTC').points).toBe(20);
    expect(earnOffPeak(c, amount, 'USD', new Date('2026-11-26T15:00:00Z'), 'UTC').points).toBe(10);
  });
});

describe('LP-07 missions', () => {
  const cfg = { missions: [{ key: 'three-in-seven', objective: 'purchases', target: '3', windowDays: 7, rewardId: R1 }, { key: 'big-spender', objective: 'spend', target: '50', windowDays: 30, rewardId: R2 }] };
  const config = (validateLp07(cfg, 'USD') as { config: Record<string, unknown> }).config;
  it('validates unique keys, bounded objectives, exact targets, and refuses feedback or rating objectives', () => {
    expect(validateLp07(cfg, 'USD')).toMatchObject({ ok: true, rewardIds: [R1, R2] });
    expect(validateLp07({ missions: [cfg.missions[0], { ...cfg.missions[0] }] }, 'USD')).toMatchObject({ ok: false, errors: [{ code: 'DUPLICATE' }] });
    for (const objective of ['rating', 'review', 'feedback', 'positive_feedback']) {
      expect(validateLp07({ missions: [{ ...cfg.missions[0], objective }] }, 'USD'), objective).toMatchObject({ ok: false });
    }
    expect(validateLp07({ missions: [{ ...cfg.missions[0], windowDays: 0 }] }, 'USD')).toMatchObject({ ok: false });
    expect(validateLp07({ missions: [{ ...cfg.missions[1], target: '10.001' }] }, 'USD')).toMatchObject({ ok: false });
    expect(validateLp07({ missions: [{ ...cfg.missions[0], key: 'Bad Key' }] }, 'USD')).toMatchObject({ ok: false });
    expect(validateLp07({ missions: [{ ...cfg.missions[0], code: 'eval()' }] }, 'USD')).toMatchObject({ ok: false }); // no executable customer rules
  });
  it('completes a mission inside its window exactly once and pays one reward', () => {
    let state = EMPTY_MISSION_STATE;
    const keys: string[] = [];
    for (const day of [1, 3, 5, 6, 7]) {
      const out = applyMissions(config, state, buy('5.00', `2026-06-0${day}T10:00:00Z`));
      state = out.state;
      keys.push(...out.grants.map((g) => g.key));
    }
    expect(keys).toEqual(['mission:three-in-seven']);
    expect(state.missions['three-in-seven']).toMatchObject({ status: 'completed', count: 3 });
  });
  it('an unfinished mission expires after its window and restarts with the next qualifying event', () => {
    let out = applyMissions(config, EMPTY_MISSION_STATE, buy('5.00', '2026-06-01T10:00:00Z'));
    out = applyMissions(config, out.state, buy('5.00', '2026-06-02T10:00:00Z'));
    out = applyMissions(config, out.state, buy('5.00', '2026-06-09T10:00:00Z')); // after the 7-day window: restart
    expect(out.grants).toEqual([]);
    expect(out.state.missions['three-in-seven']).toMatchObject({ count: 1, status: 'active', startedAt: '2026-06-09T10:00:00.000Z' });
    expect(out.steps.some((s) => s.kind === 'mission_expired:three-in-seven')).toBe(true);
  });
  it('spend objectives accumulate exact amounts and several missions advance from one event independently', () => {
    let out = applyMissions(config, EMPTY_MISSION_STATE, buy('49.99', '2026-06-01T10:00:00Z'));
    expect(out.grants).toEqual([]);
    out = applyMissions(config, out.state, buy('0.01', '2026-06-02T10:00:00Z'));
    expect(out.grants.map((g) => g.key)).toEqual(['mission:big-spender']);
    expect(out.state.missions['three-in-seven']).toMatchObject({ count: 2, status: 'active' });
  });
  it('visits missions ignore purchases and a minimum-amount filter applies only to receipts', () => {
    const c = (validateLp07({ missions: [{ key: 'v', objective: 'visits', target: '2', windowDays: 3, rewardId: R1 }, { key: 'p', objective: 'purchases', target: '1', windowDays: 3, minimumPurchaseAmount: '20', rewardId: R2 }] }, 'USD') as { config: Record<string, unknown> }).config;
    expect(applyMissions(c, EMPTY_MISSION_STATE, buy('19.99', '2026-06-01T10:00:00Z')).grants).toEqual([]);
    expect(applyMissions(c, EMPTY_MISSION_STATE, buy('20.00', '2026-06-01T10:00:00Z')).grants.map((g) => g.key)).toEqual(['mission:p']);
    let out = applyMissions(c, EMPTY_MISSION_STATE, visit('2026-06-01T10:00:00Z'));
    out = applyMissions(c, out.state, visit('2026-06-02T10:00:00Z'));
    expect(out.grants.map((g) => g.key)).toEqual(['mission:v']);
  });
  it('reads damaged counters as empty', () => {
    expect(missionStateFrom({ missions: { a: { startedAt: 'not a date' }, b: 5 } })).toEqual({ missions: {} });
    expect(missionStateFrom(null)).toEqual({ missions: {} });
  });
});

describe('dispatch through validateProgramConfig', () => {
  it('routes the four new programmes and normalises them', () => {
    expect(validateProgramConfig('LP-04', { metric: 'purchases', milestones: [{ threshold: '3', rewardId: R1 }] }, { currency: 'USD' })).toMatchObject({ ok: true });
    expect(validateProgramConfig('LP-05', { period: 'day', requiredPeriods: 3, gracePeriods: 0, evidence: 'visit', rewardId: R1 }, { currency: 'USD' })).toMatchObject({ ok: true });
    expect(validateProgramConfig('LP-06', { pointsPerCurrencyUnit: '1', windows: [{ days: [1], start: '14:00', end: '17:00', multiplier: '2' }] }, { currency: 'USD' })).toMatchObject({ ok: true });
    expect(validateProgramConfig('LP-07', { missions: [{ key: 'a', objective: 'visits', target: '2', windowDays: 3, rewardId: R1 }] }, { currency: 'USD' })).toMatchObject({ ok: true });
    expect(validateProgramConfig('LP-08', {}, { currency: 'USD' })).toMatchObject({ ok: false });
  });
});
