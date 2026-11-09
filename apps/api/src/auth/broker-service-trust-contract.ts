/**
 * B4-08: threat-model contract for a separately authenticated broker service.
 * Pure evaluation of proposed topology, NOT proof of cryptographic identity.
 * Never import this into a live route or treat self-declared inputs as trust.
 */
export type B408Topology = Readonly<{
  environment: 'disposable' | 'staging' | 'production';
  serviceIsolation: 'separate-worker' | 'shared-api-worker';
  invocationIdentity: 'cryptographic-workload-attestation' | 'shared-secret-header' | 'client-claim';
  databaseCredentialOwner: 'dedicated-broker' | 'ordinary-api-worker' | 'both';
  runtimeDatabaseRole: 'restricted-nonowner' | 'neondb_owner';
  acceptsClientVerifiedFlag: boolean;
  issuerAlgorithm: 'Ed25519' | 'HMAC-SHA256';
  verifiesCanonicalB403Assertion: boolean;
  persistsNonceAtomicallyWithRead: boolean;
  rechecksExactSessionAtUseTime: boolean;
  rechecksMembershipAndPermissionAtUseTime: boolean;
  serializesRevocationAcrossWriters: boolean;
  deniesDirectTenantTableAccess: boolean;
  poolsAreTenantIndependent: boolean;
  auditLogExcludesCredentialsAndClaims: boolean;
}>;

export type B408Assessment = Readonly<{
  threatModelRequirementsMet: boolean;
  deploymentAuthorized: false;
  reasons: readonly string[];
}>;

/**
 * Pure planning check. All values are untrusted claims from a proposed design.
 * Even zero findings never authorizes runtime use: independent workload, key
 * custody, replay, concurrency, and non-owner SQL testing are mandatory.
 */
export function assessB408Topology(candidate: unknown): B408Assessment {
  const denied = (reasons: readonly string[]): B408Assessment =>
    Object.freeze({ threatModelRequirementsMet: false, deploymentAuthorized: false, reasons });
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return denied(['INVALID_TOPOLOGY']);
  }
  const c = candidate as Record<string, unknown>;
  const failures: string[] = [];
  if (c.environment !== 'disposable') failures.push('LIVE_ENVIRONMENT_UNAUTHORIZED');
  if (c.serviceIsolation !== 'separate-worker') failures.push('SERVICE_NOT_ISOLATED');
  if (c.invocationIdentity !== 'cryptographic-workload-attestation') failures.push('UNTRUSTED_CALLER_IDENTITY');
  if (c.databaseCredentialOwner !== 'dedicated-broker') failures.push('DB_CREDENTIAL_SHARED_WITH_APP');
  if (c.runtimeDatabaseRole !== 'restricted-nonowner') failures.push('PRIVILEGED_DATABASE_ROLE');
  if (c.acceptsClientVerifiedFlag !== false) failures.push('CALLER_ASSERTED_SIGNATURE_VERDICT');
  if (c.issuerAlgorithm !== 'Ed25519' || c.verifiesCanonicalB403Assertion !== true) failures.push('SIGNATURE_PROTOCOL_MISMATCH');
  if (c.persistsNonceAtomicallyWithRead !== true) failures.push('NONCE_NOT_ATOMIC');
  if (c.rechecksExactSessionAtUseTime !== true) failures.push('SESSION_NOT_REVALIDATED');
  if (c.rechecksMembershipAndPermissionAtUseTime !== true) failures.push('PERMISSION_NOT_REVALIDATED');
  if (c.serializesRevocationAcrossWriters !== true) failures.push('REVOCATION_NOT_SERIALIZED');
  if (c.deniesDirectTenantTableAccess !== true) failures.push('DIRECT_TABLE_ACCESS');
  if (c.poolsAreTenantIndependent !== true) failures.push('POOL_CONTEXT_LEAK');
  if (c.auditLogExcludesCredentialsAndClaims !== true) failures.push('SENSITIVE_LOGGING');
  // A clean *proposed* topology still cannot grant permission to launch.
  return Object.freeze({
    threatModelRequirementsMet: failures.length === 0,
    deploymentAuthorized: false,
    reasons: failures.length > 0 ? Object.freeze(failures) : Object.freeze(['INDEPENDENT_RUNTIME_CERTIFICATION_REQUIRED']),
  });
}
