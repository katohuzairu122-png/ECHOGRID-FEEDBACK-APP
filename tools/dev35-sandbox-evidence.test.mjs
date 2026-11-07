import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDev35Manifest } from './dev35-sandbox-evidence.mjs';

const valid = () => ({
  baselineSha:'a'.repeat(40),environment:'isolated-staging',isolationVerified:true,
  migrationAuthorization:'EXPLICITLY_APPROVED',databaseMigrationStatus:'PASS',
  apiHealth:'PASS',webHealth:'PASS',tenantIsolation:'PASS',qrFeedback:'PASS',
  loyaltyAward:'PASS',loyaltyRedemption:'PASS',billingSandbox:'NOT_RUN',
  evidenceReferences:['test-run-123'],
});

test('DEV35 complete evidence never grants production or financial authority',()=>{
  const x=classifyDev35Manifest(valid());
  assert.equal(x.verdict,'SANDBOX_EVIDENCE_COMPLETE');
  assert.equal(x.productionAuthorized,false);
  assert.equal(x.deploymentAuthorized,false);
  assert.equal(x.financialAuthorization,'NOT_GRANTED');
});
test('DEV35 missing evidence and failed workflow remain not ready',()=>{
  assert.equal(classifyDev35Manifest({...valid(),evidenceReferences:[]}).verdict,'NOT_READY');
  assert.equal(classifyDev35Manifest({...valid(),tenantIsolation:'FAIL'}).verdict,'NOT_READY');
});
test('DEV35 migration cannot be passed without explicit approval',()=>{
  assert.throws(()=>classifyDev35Manifest({...valid(),migrationAuthorization:'NOT_REQUESTED'}),/DEV35_MIGRATION_AUTHORIZATION_MISSING/);
});
test('DEV35 rejects unknown fields and invalid states',()=>{
  assert.throws(()=>classifyDev35Manifest({...valid(),extra:true}),/DEV35_MANIFEST_SCHEMA_INVALID/);
  assert.throws(()=>classifyDev35Manifest({...valid(),apiHealth:'UNKNOWN'}),/DEV35_STATUS_INVALID/);
  assert.throws(()=>classifyDev35Manifest({...valid(),environment:'production'}),/DEV35_MANIFEST_INVALID/);
});
