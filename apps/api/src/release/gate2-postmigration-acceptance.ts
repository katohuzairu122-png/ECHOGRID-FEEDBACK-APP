/**
 * Gate 2 — post-migration runtime acceptance; evidence classifier only.
 *
 * Source-of-truth SQL must be read separately. No request, deployment or
 * migration route may treat this decision as a capability grant.
 */
export interface Gate2PostMigrationEvidence {
  readonly environment: 'staging' | 'production';
  readonly migrationsApplied: number;
  readonly uniqueMigrationTimestamps: number;
  readonly rlsEnabled: number;
  readonly forceRlsEnabled: number;
  readonly enabledFinancialGuards: number;
  readonly runtimeDatabaseRole: string;
  readonly runtimeBypassRls: boolean;
  readonly credentialExclusiveToRestrictedBroker: boolean;
  readonly tenantCrossAccessNegativesPass: boolean;
  readonly exactSessionRevocationPass: boolean;
  readonly brokerSignedAssertionVerifiedAtTrustBoundary: boolean;
  readonly runtimeApplicationSmokePass: boolean;
}

export interface Gate2PostMigrationAssessment {
  readonly schemaComplete: boolean;
  readonly releaseCertified: false;
  readonly deploymentAuthorized: false;
  readonly financialActivationAuthorized: false;
  readonly blockers: readonly string[];
}

export function assessGate2PostMigration(raw: unknown): Gate2PostMigrationAssessment {
  const deny=(blockers: readonly string[]): Gate2PostMigrationAssessment =>
    Object.freeze({ schemaComplete:false,releaseCertified:false,deploymentAuthorized:false,financialActivationAuthorized:false,blockers });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return deny(['INVALID_EVIDENCE']);
  const e=raw as Partial<Gate2PostMigrationEvidence>;
  if ((e.environment !== 'staging' && e.environment !== 'production') ||
      !Number.isSafeInteger(e.migrationsApplied) ||
      !Number.isSafeInteger(e.uniqueMigrationTimestamps) ||
      !Number.isSafeInteger(e.rlsEnabled) ||
      !Number.isSafeInteger(e.forceRlsEnabled) ||
      !Number.isSafeInteger(e.enabledFinancialGuards) ||
      typeof e.runtimeDatabaseRole !== 'string' ||
      typeof e.runtimeBypassRls !== 'boolean' ||
      typeof e.credentialExclusiveToRestrictedBroker !== 'boolean' ||
      typeof e.tenantCrossAccessNegativesPass !== 'boolean' ||
      typeof e.exactSessionRevocationPass !== 'boolean' ||
      typeof e.brokerSignedAssertionVerifiedAtTrustBoundary !== 'boolean' ||
      typeof e.runtimeApplicationSmokePass !== 'boolean') return deny(['INVALID_EVIDENCE']);
  const blockers: string[]=[];
  const schemaComplete=e.migrationsApplied===68&&e.uniqueMigrationTimestamps===68&&
    e.rlsEnabled===9&&e.forceRlsEnabled===9&&e.enabledFinancialGuards===6;
  if(!schemaComplete) blockers.push('SCHEMA_OR_GUARD_INCOMPLETE');
  if(e.runtimeBypassRls||e.runtimeDatabaseRole==='neondb_owner') blockers.push('RUNTIME_ROLE_BYPASSES_RLS');
  if(!e.credentialExclusiveToRestrictedBroker) blockers.push('BROKER_CREDENTIAL_CUSTODY_UNVERIFIED');
  if(!e.tenantCrossAccessNegativesPass) blockers.push('CROSS_TENANT_NEGATIVE_TESTS_UNVERIFIED');
  if(!e.exactSessionRevocationPass) blockers.push('SESSION_REVOCATION_NOT_CERTIFIED');
  if(!e.brokerSignedAssertionVerifiedAtTrustBoundary) blockers.push('SIGNED_BROKER_BOUNDARY_UNVERIFIED');
  if(!e.runtimeApplicationSmokePass) blockers.push('APPLICATION_SMOKE_UNVERIFIED');
  return Object.freeze({schemaComplete,releaseCertified:false,deploymentAuthorized:false,
    financialActivationAuthorized:false,blockers:Object.freeze(blockers.length?blockers:['INDEPENDENT_RELEASE_APPROVAL_REQUIRED'])});
}
