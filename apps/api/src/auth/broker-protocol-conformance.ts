/**
 * Gate 2 B4-05 — static interoperability decision, NOT authorization.
 *
 * B4-03 provides a development-only Ed25519 assertion contract. B4-01 and
 * B4-02 use HMAC fixtures and incompatible function names; never silently
 * translate them, accept a trusted=true flag or fall back to direct SQL.
 *
 * No API route imports this file. No signing, crypto verification, DB I/O,
 * secrets, runtime flags, migrations or privileges are introduced here.
 */
export const B405_PROTOCOL = Object.freeze({
  version: 'B4-03/1',
  algorithm: 'Ed25519',
  environment: 'development',
  issuer: 'echogrid:development:b4-03',
  audience: 'echogrid:development:branch-broker',
  workloadId: 'echogrid:development:staff-issuer',
  actorType: 'staff',
  operation: 'branches:read',
  permission: 'branches:view',
  issuerClaims: Object.freeze([
    'version', 'algorithm', 'environment', 'issuer', 'audience', 'workloadId',
    'keyId', 'keyVersion', 'actorType', 'actorId', 'sessionId', 'businessId',
    'branchId', 'operation', 'permission', 'requestId', 'nonce', 'issuedAt',
    'expiresAt', 'authorizationVersion',
  ]),
  /** No database verification routine has been approved or installed. */
  databaseVerificationReady: false,
  runtimeActivationPermitted: false,
} as const);

export type B405ProposedBrokerContract = Readonly<{
  version: string;
  algorithm: string;
  environment: string;
  issuer: string;
  audience: string;
  workloadId: string;
  actorType: string;
  operation: string;
  permission: string;
  assertionFields: readonly string[];
  /** True only if independently verified in disposable tests, NOT declared by callers. */
  databaseVerifierCertified: boolean;
  /** True only after approved key custody, revocation and restricted login. */
  trustedRuntimeCertified: boolean;
}>;

export type B405Conformance = Readonly<{
  compatible: false;
  runtimeAuthorized: false;
  reason: 'PROTOCOL_MISMATCH' | 'NO_APPROVED_DB_VERIFIER' | 'NO_TRUSTED_RUNTIME';
}>;

/**
 * Fail-closed conformance preflight. Deliberately never returns compatible:
 * a valid wire descriptor cannot establish that an issuer or DB verifier is
 * trusted. Even an untrusted caller setting certified=true grants nothing.
 * Future activation requires new reviewed code, not a flag flip.
 */
export function assessB405BrokerCompatibility(raw: unknown): B405Conformance {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { compatible: false, runtimeAuthorized: false, reason: 'PROTOCOL_MISMATCH' };
  }
  const candidate = raw as Record<string, unknown>;
  const expected = B405_PROTOCOL;
  const fields = candidate.assertionFields;
  if (candidate.version !== expected.version ||
      candidate.algorithm !== expected.algorithm ||
      candidate.environment !== expected.environment ||
      candidate.issuer !== expected.issuer ||
      candidate.audience !== expected.audience ||
      candidate.workloadId !== expected.workloadId ||
      candidate.actorType !== expected.actorType ||
      candidate.operation !== expected.operation ||
      candidate.permission !== expected.permission ||
      !Array.isArray(fields) ||
      fields.length !== expected.issuerClaims.length ||
      !fields.every((field, i) => field === expected.issuerClaims[i])) {
    return { compatible: false, runtimeAuthorized: false, reason: 'PROTOCOL_MISMATCH' };
  }
  if (candidate.databaseVerifierCertified !== true) {
    return { compatible: false, runtimeAuthorized: false, reason: 'NO_APPROVED_DB_VERIFIER' };
  }
  return { compatible: false, runtimeAuthorized: false, reason: 'NO_TRUSTED_RUNTIME' };
}
