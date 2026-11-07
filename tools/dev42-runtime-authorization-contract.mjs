/**
 * DEV-42: pure runtime-authorization CONTRACT ONLY.
 * No runtime integration, credential verification, database access or permission grant.
 */
export const DEV42_ACTIONS = Object.freeze([
  'STAGING_INTEGRATION','DATABASE_MIGRATION','DEPLOYMENT','FINANCIAL_OPERATION',
]);
export const DEV42_DENIAL_REASONS = Object.freeze([
  'NO_RUNTIME_AUTHORITY',
  'OFFLINE_EVIDENCE_NOT_AUTHORITY',
  'UNSUPPORTED_ACTION',
]);

export function evaluateDev42RuntimeContract(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).sort().join('|') !== 'action|offlineReadiness|requestedEnvironment' ||
      typeof request.action !== 'string' ||
      typeof request.requestedEnvironment !== 'string')
    throw new Error('DEV42_REQUEST_INVALID');
  if (!request.offlineReadiness || typeof request.offlineReadiness !== 'object' ||
      Array.isArray(request.offlineReadiness))
    throw new Error('DEV42_READINESS_INVALID');
  const supported = DEV42_ACTIONS.includes(request.action);
  const offlinePositive = request.offlineReadiness.reviewStatus === 'READY_FOR_SEPARATE_STAGING_AUTHORIZATION' ||
    request.offlineReadiness.verdict === 'OFFLINE_RECORD_CONSISTENT';
  return Object.freeze({
    schemaVersion:'dev42.v1',
    action:request.action,
    requestedEnvironment:request.requestedEnvironment,
    decision:'DENY',
    reason:!supported ? 'UNSUPPORTED_ACTION' :
      offlinePositive ? 'OFFLINE_EVIDENCE_NOT_AUTHORITY' : 'NO_RUNTIME_AUTHORITY',
    runtimeAuthorizationImplemented:false,
    authorizationGranted:false,
    sideEffectsPerformed:false,
  });
}
