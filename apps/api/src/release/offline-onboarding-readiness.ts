/**
 * Group 22 DEV-110–112 — pure, offline onboarding gap classifier.
 * Caller-supplied assertions are NOT verified evidence. This module never
 * authorizes onboarding, economics, migration, merging or deployment.
 */
export const MVP_GATES = [
  'MAIN_BRANCH_RECONCILED',
  'EXACT_HEAD_CI_VERIFIED_INDEPENDENTLY',
  'STAGING_RUNTIME_VERIFIED',
  'STAGING_DATABASE_AND_RLS_VERIFIED',
  'ENVIRONMENT_APPROVALS_VERIFIED',
  'AUTH_AND_TENANT_ISOLATION_VERIFIED',
  'CUSTOMER_BUSINESS_JOURNEYS_VERIFIED',
  'BILLING_TEST_MODE_VERIFIED',
  'MONITORING_ALERTS_VERIFIED',
  'BACKUP_RESTORE_DRILL_VERIFIED',
  'ROLLBACK_DRILL_VERIFIED',
  'LEGAL_POLICIES_APPROVED',
  'OWNER_WRITTEN_LAUNCH_APPROVAL',
] as const;

export const FINANCIAL_GATES = [
  'PROVIDER_EVIDENCE_CERTIFIED',
  'HISTORICAL_SUBSCRIPTION_AUTHORITY_APPROVED',
  'SETTLEMENT_ELIGIBILITY_CERTIFIED',
  'REFUND_DISPUTE_RECOVERY_CERTIFIED',
  'PARTNER_CREDIT_ACCOUNTING_CERTIFIED',
  'FINANCIAL_ACTIVATION_APPROVED',
] as const;

export type OnboardingGate = typeof MVP_GATES[number] | typeof FINANCIAL_GATES[number];
export type OnboardingTrack = 'OPERATIONAL_MVP' | 'FULL_FINANCIAL_INTEGRATION';
export type GateClaim = Readonly<{ gate: OnboardingGate; status: 'verified' | 'missing' | 'unknown' }>;
export type OnboardingAssessment = Readonly<{
  schemaVersion: 'dev110.v1';
  track: OnboardingTrack;
  status: 'BLOCKED';
  evidenceSource: 'CALLER_SUPPLIED_UNVERIFIED';
  claimsComplete: boolean;
  claimedVerified: number;
  requiredCount: number;
  unresolvedGates: readonly OnboardingGate[];
  independentlyVerified: false;
  onboardingAuthorized: false;
  productionReady: false;
  deploymentAuthorized: false;
  mergeAuthorized: false;
  migrationAuthorized: false;
  financialAuthorization: 'NOT_GRANTED';
}>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * DEV-110: conservative gap inventory for exactly two product tracks.
 * DEV-111: never treat caller claims as verified evidence or authorization.
 * DEV-112: unknown/missing/duplicate/invalid gate entries are unresolved.
 */
export function assessOfflineOnboardingReadiness(input: unknown): OnboardingAssessment {
  if (!isObject(input) || (input.track !== 'OPERATIONAL_MVP' && input.track !== 'FULL_FINANCIAL_INTEGRATION')) {
    throw new Error('DEV110_TRACK_INVALID');
  }
  const track = input.track as OnboardingTrack;
  const required: readonly OnboardingGate[] = track === 'OPERATIONAL_MVP'
    ? MVP_GATES : [...MVP_GATES, ...FINANCIAL_GATES];
  const claims = Array.isArray(input.claims) ? input.claims : null;
  const validClaims = new Map<OnboardingGate, GateClaim['status']>();
  const duplicates = new Set<OnboardingGate>();
  if (claims) {
    for (const raw of claims) {
      if (!isObject(raw) || typeof raw.gate !== 'string' ||
          !required.includes(raw.gate as OnboardingGate) ||
          !['verified', 'missing', 'unknown'].includes(String(raw.status))) continue;
      const gate = raw.gate as OnboardingGate;
      if (validClaims.has(gate)) duplicates.add(gate);
      validClaims.set(gate, raw.status as GateClaim['status']);
    }
  }
  const unresolved = required.filter(gate => validClaims.get(gate) !== 'verified' || duplicates.has(gate));
  // Even complete caller claims are not independent verification.
  const result: OnboardingAssessment = {
    schemaVersion: 'dev110.v1',
    track,
    status: 'BLOCKED',
    evidenceSource: 'CALLER_SUPPLIED_UNVERIFIED',
    claimsComplete: claims !== null && claims.length === required.length &&
      required.every(gate => validClaims.has(gate) && !duplicates.has(gate)),
    claimedVerified: required.filter(gate => validClaims.get(gate) === 'verified' && !duplicates.has(gate)).length,
    requiredCount: required.length,
    unresolvedGates: Object.freeze(unresolved),
    independentlyVerified: false,
    onboardingAuthorized: false,
    productionReady: false,
    deploymentAuthorized: false,
    mergeAuthorized: false,
    migrationAuthorized: false,
    financialAuthorization: 'NOT_GRANTED',
  };
  return Object.freeze(result);
}
