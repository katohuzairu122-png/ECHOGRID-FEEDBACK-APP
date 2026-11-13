import { describe, expect, it } from 'vitest';
import { assessGate2PostMigration, type Gate2PostMigrationEvidence } from './gate2-postmigration-acceptance';

const observed=():Gate2PostMigrationEvidence=>({
  environment:'production', migrationsApplied:70,uniqueMigrationTimestamps:70,
  rlsEnabled:9,forceRlsEnabled:9,enabledFinancialGuards:6,
  runtimeDatabaseRole:'neondb_owner',runtimeBypassRls:true,
  credentialExclusiveToRestrictedBroker:false,
  tenantCrossAccessNegativesPass:false,exactSessionRevocationPass:false,
  brokerSignedAssertionVerifiedAtTrustBoundary:false,runtimeApplicationSmokePass:false,
});

describe('Gate 2 post-migration evidence does not authorize runtime cutover',()=>{
  it('distinguishes complete schema from uncertified runtime',()=>{
    const result=assessGate2PostMigration(observed());
    expect(result.schemaComplete).toBe(true);
    expect(result.releaseCertified).toBe(false);
    expect(result.deploymentAuthorized).toBe(false);
    expect(result.financialActivationAuthorized).toBe(false);
    expect(result.blockers).toContain('RUNTIME_ROLE_BYPASSES_RLS');
    expect(result.blockers).toContain('SIGNED_BROKER_BOUNDARY_UNVERIFIED');
  });
  it('fails closed when force RLS or inert financial guards are absent',()=>{
    expect(assessGate2PostMigration({...observed(),forceRlsEnabled:8}).blockers).toContain('SCHEMA_OR_GUARD_INCOMPLETE');
    expect(assessGate2PostMigration({...observed(),enabledFinancialGuards:5}).blockers).toContain('SCHEMA_OR_GUARD_INCOMPLETE');
  });
  it('does not accept a non-owner role name when bypass remains true',()=>{
    expect(assessGate2PostMigration({...observed(),runtimeDatabaseRole:'restricted',runtimeBypassRls:true})
      .blockers).toContain('RUNTIME_ROLE_BYPASSES_RLS');
  });
  it('does not authorize deployment based on self-declared completed checks',()=>{
    const proposal={...observed(),runtimeDatabaseRole:'restricted',runtimeBypassRls:false,
      credentialExclusiveToRestrictedBroker:true,
      tenantCrossAccessNegativesPass:true,exactSessionRevocationPass:true,
      brokerSignedAssertionVerifiedAtTrustBoundary:true,runtimeApplicationSmokePass:true};
    expect(assessGate2PostMigration(proposal)).toEqual({
      schemaComplete:true,releaseCertified:false,deploymentAuthorized:false,
      financialActivationAuthorized:false,blockers:['INDEPENDENT_RELEASE_APPROVAL_REQUIRED'],
    });
  });
  it.each([null,[],{},'ready',42,{...observed(),runtimeBypassRls:'false'}])('denies invalid evidence %#',raw=>{
    expect(assessGate2PostMigration(raw)).toMatchObject({
      schemaComplete:false,releaseCertified:false,deploymentAuthorized:false,
      financialActivationAuthorized:false,blockers:['INVALID_EVIDENCE'],
    });
  });
});
