import { generateDev39ReadinessReport, formatDev39ReadinessMarkdown } from './dev39-readiness-report.mjs';

/**
 * DEV-40: offline report finalization with explicit independent-review gates.
 * A reviewer assertion is recorded, not independently authenticated.
 */
export function finalizeDev40OfflineReview(input, review) {
  if (!review || typeof review !== 'object' || Array.isArray(review) ||
      Object.keys(review).sort().join('|') !== 'baselineSha|decision|evidenceReviewed|reviewerReference' ||
      typeof review.baselineSha !== 'string' ||
      typeof review.reviewerReference !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,127}$/.test(review.reviewerReference) ||
      !['APPROVED_FOR_FUTURE_STAGING_REVIEW','REJECTED'].includes(review.decision) ||
      typeof review.evidenceReviewed !== 'boolean')
    throw new Error('DEV40_REVIEW_INVALID');
  const report=generateDev39ReadinessReport(input);
  if (review.baselineSha !== report.baselineSha)
    throw new Error('DEV40_BASELINE_MISMATCH');
  const accepted=report.verdict==='OFFLINE_RECORD_CONSISTENT' &&
    review.decision==='APPROVED_FOR_FUTURE_STAGING_REVIEW' &&
    review.evidenceReviewed===true;
  return Object.freeze({
    schemaVersion:'dev40.v1',
    baselineSha:report.baselineSha,
    offlineVerdict:report.verdict,
    reviewStatus:accepted ? 'READY_FOR_SEPARATE_STAGING_AUTHORIZATION' : 'BLOCKED',
    reviewerReference:review.reviewerReference,
    reviewerIdentityAuthenticated:false,
    evidenceIndependentlyVerifiedBySystem:false,
    integrationExecuted:false,
    migrationExecuted:false,
    stagingExecutionAuthorized:false,
    deploymentAuthorized:false,
    financialAuthorization:'NOT_GRANTED',
  });
}

export function formatDev40OfflineReviewMarkdown(result) {
  if (!result || result.schemaVersion!=='dev40.v1' ||
      !/^[a-f0-9]{40}$/.test(result.baselineSha ?? '') ||
      !['READY_FOR_SEPARATE_STAGING_AUTHORIZATION','BLOCKED'].includes(result.reviewStatus))
    throw new Error('DEV40_REPORT_INVALID');
  return [
    '# DEV-40 — Offline Review Finalization',
    '',
    '- Baseline: '+result.baselineSha,
    '- Offline verdict: '+result.offlineVerdict,
    '- Review status: '+result.reviewStatus,
    '- Reviewer identity authenticated by system: NO',
    '- Evidence independently verified by system: NO',
    '- Integration executed: NO',
    '- Migrations executed: NO',
    '- Staging execution authorized: NO',
    '- Deployment authorized: NO',
    '- Financial authorization: NOT_GRANTED',
    '',
    'A recorded reviewer assertion is not permission to run migrations, integrate services, deploy, or move money. Obtain separate explicit owner authorization.',
    '',
  ].join('\n');
}
