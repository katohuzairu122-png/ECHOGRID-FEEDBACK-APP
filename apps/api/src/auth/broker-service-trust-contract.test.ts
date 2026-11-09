import { describe, expect, it } from 'vitest';
import { assessB408Topology, type B408Topology } from './broker-service-trust-contract';

const safeProposal = (): B408Topology => ({
  environment: 'disposable',
  serviceIsolation: 'separate-worker',
  invocationIdentity: 'cryptographic-workload-attestation',
  databaseCredentialOwner: 'dedicated-broker',
  runtimeDatabaseRole: 'restricted-nonowner',
  acceptsClientVerifiedFlag: false,
  issuerAlgorithm: 'Ed25519',
  verifiesCanonicalB403Assertion: true,
  persistsNonceAtomicallyWithRead: true,
  rechecksExactSessionAtUseTime: true,
  rechecksMembershipAndPermissionAtUseTime: true,
  serializesRevocationAcrossWriters: true,
  deniesDirectTenantTableAccess: true,
  poolsAreTenantIndependent: true,
  auditLogExcludesCredentialsAndClaims: true,
});

describe('Gate 2 B4-08 isolated broker planning gate — no deployment authority', () => {
  it('never grants deployment even if every requirement is declared satisfied', () => {
    expect(assessB408Topology(safeProposal())).toEqual({
      threatModelRequirementsMet: true,
      deploymentAuthorized: false,
      reasons: ['INDEPENDENT_RUNTIME_CERTIFICATION_REQUIRED'],
    });
  });

  it.each([
    [{ environment: 'staging' }, 'LIVE_ENVIRONMENT_UNAUTHORIZED'],
    [{ environment: 'production' }, 'LIVE_ENVIRONMENT_UNAUTHORIZED'],
    [{ serviceIsolation: 'shared-api-worker' }, 'SERVICE_NOT_ISOLATED'],
    [{ invocationIdentity: 'client-claim' }, 'UNTRUSTED_CALLER_IDENTITY'],
    [{ invocationIdentity: 'shared-secret-header' }, 'UNTRUSTED_CALLER_IDENTITY'],
    [{ databaseCredentialOwner: 'ordinary-api-worker' }, 'DB_CREDENTIAL_SHARED_WITH_APP'],
    [{ databaseCredentialOwner: 'both' }, 'DB_CREDENTIAL_SHARED_WITH_APP'],
    [{ runtimeDatabaseRole: 'neondb_owner' }, 'PRIVILEGED_DATABASE_ROLE'],
    [{ acceptsClientVerifiedFlag: true }, 'CALLER_ASSERTED_SIGNATURE_VERDICT'],
    [{ issuerAlgorithm: 'HMAC-SHA256' }, 'SIGNATURE_PROTOCOL_MISMATCH'],
    [{ verifiesCanonicalB403Assertion: false }, 'SIGNATURE_PROTOCOL_MISMATCH'],
    [{ persistsNonceAtomicallyWithRead: false }, 'NONCE_NOT_ATOMIC'],
    [{ rechecksExactSessionAtUseTime: false }, 'SESSION_NOT_REVALIDATED'],
    [{ rechecksMembershipAndPermissionAtUseTime: false }, 'PERMISSION_NOT_REVALIDATED'],
    [{ serializesRevocationAcrossWriters: false }, 'REVOCATION_NOT_SERIALIZED'],
    [{ deniesDirectTenantTableAccess: false }, 'DIRECT_TABLE_ACCESS'],
    [{ poolsAreTenantIndependent: false }, 'POOL_CONTEXT_LEAK'],
    [{ auditLogExcludesCredentialsAndClaims: false }, 'SENSITIVE_LOGGING'],
  ] as const)('rejects unsafe topology deviation %#', (patch, reason) => {
    const result = assessB408Topology({ ...safeProposal(), ...patch });
    expect(result.threatModelRequirementsMet).toBe(false);
    expect(result.deploymentAuthorized).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it.each([null, undefined, [], false, 1, 'approved'])(
    'rejects malformed and caller-asserted inputs %#', raw => {
      expect(assessB408Topology(raw)).toEqual({
        threatModelRequirementsMet: false,
        deploymentAuthorized: false,
        reasons: ['INVALID_TOPOLOGY'],
      });
    },
  );
});
