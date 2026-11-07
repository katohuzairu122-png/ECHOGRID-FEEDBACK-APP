/**
 * DEV-58 — deterministic, OFFLINE release-candidate evidence classifier.
 *
 * This does not query GitHub, Cloudflare, Neon or Stripe. Caller-supplied CI
 * fields are never independently verified by this module. It must not create
 * or imply authority to merge, migrate, activate finance or deploy.
 */
export type OfflineEvidenceStatus = 'BLOCKED' | 'OFFLINE_CI_RECORD_CONSISTENT';
export type OfflineEvidenceReason =
  | 'CI_RECORD_MISSING'
  | 'CI_RECORD_INVALID'
  | 'CI_COMMIT_MISMATCH'
  | 'CI_RUN_INCOMPLETE'
  | 'CI_RUN_NOT_SUCCESSFUL'
  | 'REQUIRES_INDEPENDENT_REVIEW';

export type ReleaseEvidenceAssessment = Readonly<{
  schemaVersion: 'dev58.v1';
  baselineSha: string;
  status: OfflineEvidenceStatus;
  reason: OfflineEvidenceReason;
  source: 'CALLER_SUPPLIED_OFFLINE_CI_METADATA';
  independentlyVerified: false;
  stagingRuntimeVerified: false;
  productionRuntimeVerified: false;
  mergeAuthorized: false;
  migrationAuthorized: false;
  deploymentAuthorized: false;
  financialAuthorization: 'NOT_GRANTED';
  outstandingGates: readonly string[];
}>;

const SHA = /^[a-f0-9]{40}$/;

/** Constant obligations remain even if a caller asserts CI success. */
const REQUIRED_EXTERNAL_GATES = Object.freeze([
  'AUTHORITATIVE_MAIN_AND_PR_RECONCILIATION',
  'INDEPENDENT_CI_EVIDENCE_VERIFICATION',
  'OWNER_MERGE_REVIEW',
  'STAGING_ENVIRONMENT_PROTECTION_VERIFICATION',
  'STAGING_RUNTIME_AND_DATABASE_VALIDATION',
  'PRODUCTION_SECRET_AND_REVIEWER_ISOLATION_VERIFICATION',
  'EXPLICIT_PRODUCTION_RELEASE_AUTHORIZATION',
] as const);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Validates only metadata. Never consumes raw evidence, URLs or credentials. */
export function assessDev58ReleaseEvidence(input: unknown): ReleaseEvidenceAssessment {
  const record = objectValue(input);
  if (!record || typeof record.baselineSha !== 'string' || !SHA.test(record.baselineSha)) {
    throw new Error('DEV58_BASELINE_SHA_INVALID');
  }

  const ci = objectValue(record.ci);
  let status: OfflineEvidenceStatus = 'BLOCKED';
  let reason: OfflineEvidenceReason = 'CI_RECORD_MISSING';

  if (ci) {
    if (
      typeof ci.commitSha !== 'string' || !SHA.test(ci.commitSha) ||
      typeof ci.runId !== 'number' || !Number.isSafeInteger(ci.runId) || ci.runId < 1 ||
      !['queued', 'in_progress', 'completed'].includes(String(ci.status)) ||
      ![null, 'success', 'failure', 'cancelled', 'skipped', 'timed_out'].includes(ci.conclusion as string | null)
    ) {
      reason = 'CI_RECORD_INVALID';
    } else if (ci.commitSha !== record.baselineSha) {
      reason = 'CI_COMMIT_MISMATCH';
    } else if (ci.status !== 'completed') {
      reason = 'CI_RUN_INCOMPLETE';
    } else if (ci.conclusion !== 'success') {
      reason = 'CI_RUN_NOT_SUCCESSFUL';
    } else {
      status = 'OFFLINE_CI_RECORD_CONSISTENT';
      reason = 'REQUIRES_INDEPENDENT_REVIEW';
    }
  }

  return Object.freeze({
    schemaVersion: 'dev58.v1' as const,
    baselineSha: record.baselineSha,
    status, reason,
    source: 'CALLER_SUPPLIED_OFFLINE_CI_METADATA' as const,
    independentlyVerified: false as const,
    stagingRuntimeVerified: false as const,
    productionRuntimeVerified: false as const,
    mergeAuthorized: false as const,
    migrationAuthorized: false as const,
    deploymentAuthorized: false as const,
    financialAuthorization: 'NOT_GRANTED' as const,
    outstandingGates: REQUIRED_EXTERNAL_GATES,
  });
}

export function formatDev58ReleaseEvidence(assessment: ReleaseEvidenceAssessment): string {
  if (assessment.schemaVersion !== 'dev58.v1' || !SHA.test(assessment.baselineSha) ||
      !['BLOCKED', 'OFFLINE_CI_RECORD_CONSISTENT'].includes(assessment.status)) {
    throw new Error('DEV58_ASSESSMENT_INVALID');
  }
  return [
    '# DEV-58 — Offline Release Candidate Evidence',
    '',
    `- Baseline SHA: ${assessment.baselineSha}`,
    `- Offline evidence: ${assessment.status} (${assessment.reason})`,
    '- Independently verified: NO',
    '- Staging runtime verified: NO',
    '- Production runtime verified: NO',
    '- Merge authorized: NO',
    '- Migration authorized: NO',
    '- Deployment authorized: NO',
    '- Financial authorization: NOT_GRANTED',
    '',
    'External gates remain unresolved: ' + assessment.outstandingGates.join(', '),
    '',
    'A caller-supplied CI success record is not proof of a passing GitHub run, protected environment, safe release or owner approval.',
    '',
  ].join('\n');
}
