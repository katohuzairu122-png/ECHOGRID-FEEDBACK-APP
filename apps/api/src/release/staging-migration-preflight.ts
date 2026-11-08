/**
 * Gate 2 — non-authorizing, offline classification of staging database drift.
 * This pure assessment accepts externally observed evidence. It does not
 * connect to Neon, apply migrations, change database privileges, or certify
 * a provider's operational security.
 */
export interface StagingPreflightInput {
  expectedJournal: readonly { tag: string; when: number }[];
  appliedCreatedAt: readonly (number | string)[];
  pgMajor: number;
  publicTables: number;
  rlsEnabledTables: number;
  requiredInertTriggers: readonly string[];
  observedEnabledTriggers: readonly string[];
  missingRequiredRoles: readonly string[];
  backupRestoreDrillVerified: boolean;
  stagingEnvironmentProtectionVerified: boolean;
}

export type StagingPreflightReason =
  | 'INVALID_EVIDENCE'
  | 'MIGRATION_CHAIN_MISMATCH'
  | 'MIGRATIONS_PENDING'
  | 'DATABASE_VERSION_NOT_CERTIFIED'
  | 'NEW_SECURITY_MIGRATIONS_PENDING'
  | 'INERT_TRIGGERS_MISSING'
  | 'ROLE_PROTECTION_UNVERIFIED'
  | 'RLS_REVIEW_REQUIRED'
  | 'BACKUP_RESTORE_UNVERIFIED'
  | 'ENVIRONMENT_PROTECTION_UNVERIFIED';

export interface StagingPreflightResult {
  readonly status: 'BLOCKED';
  readonly reasons: readonly StagingPreflightReason[];
  readonly appliedCount: number;
  readonly expectedCount: number;
  readonly pendingTags: readonly string[];
  readonly stagingCertified: false;
  readonly migrationAuthorized: false;
  readonly deploymentAuthorized: false;
  readonly onboardingAuthorized: false;
  readonly financialAuthorization: 'NOT_GRANTED';
}
const safeCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const tagPattern = /^[0-9]{4}_[a-z0-9_]+$/;
const asTimestamp = (v: unknown): number | null => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^[0-9]+$/.test(v))) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function assessStagingMigrationPreflight(input: unknown): StagingPreflightResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('GATE2_EVIDENCE_INVALID');
  const v = input as Partial<StagingPreflightInput>;
  if (!Array.isArray(v.expectedJournal) || !Array.isArray(v.appliedCreatedAt) ||
      !Array.isArray(v.requiredInertTriggers) || !Array.isArray(v.observedEnabledTriggers) ||
      !Array.isArray(v.missingRequiredRoles) ||
      !safeCount(v.pgMajor) || !safeCount(v.publicTables) || !safeCount(v.rlsEnabledTables) ||
      typeof v.backupRestoreDrillVerified !== 'boolean' ||
      typeof v.stagingEnvironmentProtectionVerified !== 'boolean') {
    throw new Error('GATE2_EVIDENCE_INVALID');
  }
  const journal = v.expectedJournal;
  const applied = v.appliedCreatedAt;
  if (!journal.length || journal.some((e, i) => !e || !tagPattern.test(e.tag) ||
      asTimestamp(e.when) === null || !e.tag.startsWith(String(i).padStart(4, '0') + '_') ||
      (i > 0 && e.when <= journal[i - 1]!.when)) ||
      applied.some(t => asTimestamp(t) === null) ||
      [...v.requiredInertTriggers, ...v.observedEnabledTriggers, ...v.missingRequiredRoles].some(t => typeof t !== 'string' || !/^[a-z0-9_]+$/.test(t))) {
    throw new Error('GATE2_EVIDENCE_INVALID');
  }

  const reasons = new Set<StagingPreflightReason>();
  const completePrefix = applied.length <= journal.length &&
    applied.every((time, i) => asTimestamp(time) === journal[i]!.when);
  if (!completePrefix) reasons.add('MIGRATION_CHAIN_MISMATCH');
  if (applied.length < journal.length) reasons.add('MIGRATIONS_PENDING');
  if (v.pgMajor !== 16) reasons.add('DATABASE_VERSION_NOT_CERTIFIED');
  if (applied.length < journal.length && journal.slice(applied.length).some(e => Number(e.tag.slice(0, 4)) >= 61))
    reasons.add('NEW_SECURITY_MIGRATIONS_PENDING');
  if (v.requiredInertTriggers.some(t => !v.observedEnabledTriggers!.includes(t)))
    reasons.add('INERT_TRIGGERS_MISSING');
  if (v.missingRequiredRoles.length) reasons.add('ROLE_PROTECTION_UNVERIFIED');
  // RLS is selectively introduced by later migrations; zero RLS with pending
  // security migrations requires review, not an assertion all tables need RLS.
  if ((v.publicTables ?? 0) > 0 && v.rlsEnabledTables === 0) reasons.add('RLS_REVIEW_REQUIRED');
  if (!v.backupRestoreDrillVerified) reasons.add('BACKUP_RESTORE_UNVERIFIED');
  if (!v.stagingEnvironmentProtectionVerified) reasons.add('ENVIRONMENT_PROTECTION_UNVERIFIED');

  return Object.freeze({
    status: 'BLOCKED' as const,
    reasons: Object.freeze([...reasons].sort()),
    appliedCount: applied.length,
    expectedCount: journal.length,
    pendingTags: Object.freeze(completePrefix ? journal.slice(applied.length).map(e => e.tag) : []),
    stagingCertified: false as const,
    migrationAuthorized: false as const,
    deploymentAuthorized: false as const,
    onboardingAuthorized: false as const,
    financialAuthorization: 'NOT_GRANTED' as const,
  });
}
