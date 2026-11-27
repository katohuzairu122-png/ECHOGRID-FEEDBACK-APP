import { describe, expect, it } from 'vitest';
import { applyMilestone, applyMissions, applyStreak, milestoneStateFrom, missionStateFrom, streakStateFrom, type ProgressEvent } from '@echo-grid-feedback/shared-types';
import { replayProgress, sameCounters, type ReplayStep } from './progress-replay';

const reward = '6f0f1c5e-0000-4000-8000-000000000001';
const tz = 'UTC';
const day = (n: number): Date => new Date(Date.UTC(2026, 5, 1 + n, 12));
const purchase = (n: number, amountMinor = 500n): ProgressEvent => ({ kind: 'purchase', amountMinor, currency: 'USD', occurredAt: day(n) });
const visit = (n: number): ProgressEvent => ({ kind: 'visit', occurredAt: day(n) });

describe('replayProgress (LPC-08)', () => {
  it('reproduces exactly what the live engines produced for a streak', () => {
    const config = { period: 'day', requiredPeriods: 3, gracePeriods: 0, evidence: 'visit', rewardId: reward };
    const events = [visit(0), visit(1), visit(2), visit(3)];
    let live = streakStateFrom({});
    const liveGrants: string[] = [];
    const recorded: ReplayStep[] = [];
    for (const event of events) {
      const out = applyStreak(config, live, event, tz);
      if (out.steps.length === 0) continue; // an event that changed nothing is never recorded
      live = out.state;
      out.grants.forEach((g) => liveGrants.push(g.key));
      recorded.push({ config, event });
    }
    const replay = replayProgress('LP-05', recorded, tz);
    expect(sameCounters(replay.counters, { ...live })).toBe(true);
    expect([...replay.grants.keys()]).toEqual(liveGrants);
  });

  it('removing a day from a streak shortens it and withdraws the reward it earned', () => {
    const config = { period: 'day', requiredPeriods: 3, gracePeriods: 0, evidence: 'visit', rewardId: reward };
    const steps: ReplayStep[] = [visit(0), visit(1), visit(2)].map((event) => ({ config, event }));
    expect(replayProgress('LP-05', steps, tz).grants.size).toBe(1);
    const without = replayProgress('LP-05', steps.slice(0, 2), tz);
    expect(without.grants.size).toBe(0);
    expect(without.counters).toMatchObject({ streak: 2 });
  });

  it('reproduces milestones and missions, and drops the grants a removed event earned', () => {
    const lp04 = { metric: 'purchases', milestones: [{ threshold: '2', rewardId: reward }] };
    const liveSteps: ReplayStep[] = [purchase(0), purchase(1), purchase(2)].map((event) => ({ config: lp04, event }));
    let state = milestoneStateFrom({});
    for (const step of liveSteps) state = applyMilestone(lp04, state, step.event).state;
    expect(sameCounters(replayProgress('LP-04', liveSteps, tz).counters, { ...state })).toBe(true);
    expect(replayProgress('LP-04', liveSteps, tz).grants.size).toBe(1);
    expect(replayProgress('LP-04', [liveSteps[0]!, liveSteps[2]!].slice(0, 1), tz).grants.size).toBe(0);

    const lp07 = { missions: [{ key: 'a', objective: 'purchases', target: '2', windowDays: 10, rewardId: reward }] };
    const mSteps: ReplayStep[] = [purchase(0), purchase(1)].map((event) => ({ config: lp07, event }));
    let mState = missionStateFrom({});
    for (const step of mSteps) mState = applyMissions(lp07, mState, step.event).state;
    expect(sameCounters(replayProgress('LP-07', mSteps, tz).counters, { ...mState })).toBe(true);
    expect(replayProgress('LP-07', mSteps.slice(0, 1), tz).grants.size).toBe(0);
  });

  it('sameCounters ignores key order and undefined, and notices a real difference', () => {
    expect(sameCounters({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1, z: undefined })).toBe(true);
    expect(sameCounters({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameCounters(null, {})).toBe(true);
  });
});
