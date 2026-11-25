import { describe, expect, it } from 'vitest';
import { resolveMinimumGroupSize, summarizeParticipation } from './community-participation-aggregate';

describe('resolveMinimumGroupSize', () => {
  it('defaults to 10, never goes below 10, and fails toward more privacy on anything odd', () => {
    expect(resolveMinimumGroupSize(undefined)).toBe(10);
    for (const bad of ['', 'abc', '-5', '5.5', '0', '9', '1e3', ' 20', '20 ', 20, null]) expect(resolveMinimumGroupSize(bad), String(bad)).toBe(10);
    expect(resolveMinimumGroupSize('10')).toBe(10);
    expect(resolveMinimumGroupSize('25')).toBe(25);
    expect(resolveMinimumGroupSize('999999')).toBe(1000);
  });
});

describe('summarizeParticipation', () => {
  const shown = (value: number) => ({ state: 'shown', value });
  const hidden = { state: 'suppressed' };

  it('suppresses every figure for a small business and reveals no count', () => {
    for (const c of [{ eligible: 0, participants: 0 }, { eligible: 9, participants: 9 }, { eligible: 9, participants: 3 }]) {
      expect(summarizeParticipation(c, 10)).toEqual({ minimumGroupSize: 10, eligible: hidden, participants: hidden, ratePercent: hidden });
    }
  });

  it('shows the total but hides a small participant group (boundary: 9 hidden, 10 shown)', () => {
    expect(summarizeParticipation({ eligible: 100, participants: 9 }, 10)).toMatchObject({ eligible: shown(100), participants: hidden, ratePercent: hidden });
    expect(summarizeParticipation({ eligible: 100, participants: 10 }, 10)).toMatchObject({ eligible: shown(100), participants: shown(10), ratePercent: shown(10) });
  });

  it('hides participants when the non-participants would be a small group (no disclosure by subtraction)', () => {
    expect(summarizeParticipation({ eligible: 100, participants: 91 }, 10)).toMatchObject({ participants: hidden, ratePercent: hidden });
    expect(summarizeParticipation({ eligible: 100, participants: 90 }, 10)).toMatchObject({ participants: shown(90), ratePercent: shown(90) });
    expect(summarizeParticipation({ eligible: 100, participants: 100 }, 10)).toMatchObject({ participants: hidden });
  });

  it('honours a larger configured group size and rounds the rate to a whole percentage', () => {
    expect(summarizeParticipation({ eligible: 40, participants: 15 }, 20)).toMatchObject({ eligible: shown(40), participants: hidden });
    expect(summarizeParticipation({ eligible: 30, participants: 10 }, 10)).toMatchObject({ participants: shown(10), ratePercent: shown(33) });
  });

  it('clamps impossible inputs (negative, fractional, participants above eligible)', () => {
    expect(summarizeParticipation({ eligible: -5, participants: -1 }, 10)).toMatchObject({ eligible: hidden });
    expect(summarizeParticipation({ eligible: 50, participants: 80 }, 10)).toMatchObject({ participants: hidden });
  });

  it('exposes only the documented keys', () => {
    expect(Object.keys(summarizeParticipation({ eligible: 100, participants: 40 }, 10)).sort()).toEqual(['eligible', 'minimumGroupSize', 'participants', 'ratePercent']);
  });
});
