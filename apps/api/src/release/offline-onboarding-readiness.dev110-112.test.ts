import { describe, expect, it } from 'vitest';
import {
  assessOfflineOnboardingReadiness, MVP_GATES, FINANCIAL_GATES,
  type OnboardingGate, type OnboardingTrack,
} from './offline-onboarding-readiness';

const assessment = (track: OnboardingTrack, claims?: unknown, extra = {}) =>
  assessOfflineOnboardingReadiness({ track, claims, ...extra });
const verified = (gates: readonly OnboardingGate[]) =>
  gates.map(gate => ({ gate, status: 'verified' }));

describe('Group 22 independent onboarding readiness boundary', () => {
  it('DEV-110 lists every operational MVP gate without requiring advanced economic activation', () => {
    const a = assessment('OPERATIONAL_MVP');
    expect(a.requiredCount).toBe(MVP_GATES.length);
    expect(a.unresolvedGates).toEqual(MVP_GATES);
    expect(a.unresolvedGates).not.toContain('FINANCIAL_ACTIVATION_APPROVED');
    expect(a.status).toBe('BLOCKED');
  });

  it('DEV-110 adds the financial authority gates only for the full-integration track', () => {
    const a = assessment('FULL_FINANCIAL_INTEGRATION');
    expect(a.requiredCount).toBe(MVP_GATES.length + FINANCIAL_GATES.length);
    expect(a.unresolvedGates).toEqual([...MVP_GATES, ...FINANCIAL_GATES]);
  });

  it.each(['OPERATIONAL_MVP', 'FULL_FINANCIAL_INTEGRATION'] as const)(
    'DEV-111 never converts all positive claims to permission: %s', track => {
      const gates = track === 'OPERATIONAL_MVP' ? MVP_GATES : [...MVP_GATES, ...FINANCIAL_GATES];
      const a = assessment(track, verified(gates), {
        independentlyVerified: true, onboardingAuthorized: true,
        deploymentAuthorized: true, financialAuthorization: 'GRANTED',
      });
      expect(a).toMatchObject({
        status: 'BLOCKED', claimsComplete: true, claimedVerified: gates.length,
        independentlyVerified: false, onboardingAuthorized: false,
        productionReady: false, deploymentAuthorized: false, mergeAuthorized: false,
        migrationAuthorized: false, financialAuthorization: 'NOT_GRANTED',
        unresolvedGates: [],
      });
      expect(Object.isFrozen(a)).toBe(true);
      expect(Object.isFrozen(a.unresolvedGates)).toBe(true);
    },
  );

  it('DEV-112 rejects duplicate claims as unresolved, even when a later claim says verified', () => {
    const a = assessment('OPERATIONAL_MVP', [
      ...verified(MVP_GATES.filter(g => g !== 'MAIN_BRANCH_RECONCILED')),
      { gate: 'MAIN_BRANCH_RECONCILED', status: 'missing' },
      { gate: 'MAIN_BRANCH_RECONCILED', status: 'verified' },
    ]);
    expect(a.unresolvedGates).toContain('MAIN_BRANCH_RECONCILED');
    expect(a.claimsComplete).toBe(false);
    expect(a.onboardingAuthorized).toBe(false);
  });

  it.each([null, undefined, [], {}, 'invalid', 42, { track: 'OTHER' }])(
    'DEV-112 rejects malformed assessment envelope %#', input => {
      expect(() => assessOfflineOnboardingReadiness(input)).toThrow('DEV110_TRACK_INVALID');
    },
  );

  it('DEV-112 treats malformed, unknown, unrelated and false evidence as unresolved', () => {
    const claims = [
      { gate: 'MAIN_BRANCH_RECONCILED', status: 'false' },
      { gate: 'STAGING_RUNTIME_VERIFIED', status: true },
      { gate: 'UNKNOWN_GATE', status: 'verified' },
      null,
      { gate: 'LEGAL_POLICIES_APPROVED', status: 'missing' },
      { gate: 'FINANCIAL_ACTIVATION_APPROVED', status: 'verified' },
    ];
    const a = assessment('OPERATIONAL_MVP', claims);
    expect(a.claimedVerified).toBe(0);
    expect(a.unresolvedGates).toEqual(MVP_GATES);
    expect(a.claimsComplete).toBe(false);
    expect(JSON.stringify(a)).not.toContain('UNKNOWN_GATE');
  });

  it('DEV-112 cannot echo secrets, authorizations, or raw evidence from input', () => {
    const a = assessment('OPERATIONAL_MVP', verified(MVP_GATES), {
      secrets: 'sk_live_NEVER_ECHO', sourceUrl: 'https://private.test',
    });
    const text = JSON.stringify(a);
    expect(text).not.toContain('sk_live_NEVER_ECHO');
    expect(text).not.toContain('private.test');
    expect(text).not.toContain('secrets');
  });
});
