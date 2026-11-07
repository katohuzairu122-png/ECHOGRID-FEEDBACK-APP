import { finalizeDev40OfflineReview } from './dev40-offline-review.mjs';

/**
 * DEV-41: fail-closed authorization boundary.
 * Offline readiness, even with a positive review assertion, never grants
 * execution permissions. This function has no side effects.
 */
export function evaluateDev41ExecutionBoundary(input, review, requestedAction) {
  const actions = ['STAGING_INTEGRATION','DATABASE_MIGRATION','DEPLOYMENT','FINANCIAL_OPERATION'];
  if (!actions.includes(requestedAction)) throw new Error('DEV41_ACTION_INVALID');
  const reviewed = finalizeDev40OfflineReview(input, review);
  return Object.freeze({
    schemaVersion:'dev41.v1',
    baselineSha:reviewed.baselineSha,
    requestedAction,
    offlineReviewStatus:reviewed.reviewStatus,
    decision:'DENIED',
    reason:reviewed.reviewStatus==='READY_FOR_SEPARATE_STAGING_AUTHORIZATION'
      ? 'SEPARATE_EXPLICIT_AUTHORIZATION_REQUIRED'
      : 'OFFLINE_REVIEW_BLOCKED',
    authorizationSource:'NONE',
    externalVerificationPerformed:false,
    integrationExecuted:false,
    migrationExecuted:false,
    deploymentExecuted:false,
    financialOperationExecuted:false,
  });
}
