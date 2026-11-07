import test from 'node:test';
import assert from 'node:assert/strict';
import {DEV42_ACTIONS,evaluateDev42RuntimeContract} from './dev42-runtime-authorization-contract.mjs';

for (const action of DEV42_ACTIONS) {
  test('DEV42 denies '+action+' for positive offline review',()=>{
    const x=evaluateDev42RuntimeContract({
      action,requestedEnvironment:'isolated-staging',
      offlineReadiness:{reviewStatus:'READY_FOR_SEPARATE_STAGING_AUTHORIZATION'},
    });
    assert.equal(x.decision,'DENY');
    assert.equal(x.reason,'OFFLINE_EVIDENCE_NOT_AUTHORITY');
    assert.equal(x.runtimeAuthorizationImplemented,false);
    assert.equal(x.authorizationGranted,false);
    assert.equal(x.sideEffectsPerformed,false);
  });
}
test('DEV42 denies unsupported actions',()=>{
  assert.equal(evaluateDev42RuntimeContract({action:'PRODUCTION_OVERRIDE',requestedEnvironment:'production',offlineReadiness:{}}).reason,'UNSUPPORTED_ACTION');
});
test('DEV42 fails closed on missing inputs',()=>{
  assert.throws(()=>evaluateDev42RuntimeContract(null),/DEV42_REQUEST_INVALID/);
  assert.throws(()=>evaluateDev42RuntimeContract({action:'DEPLOYMENT',requestedEnvironment:'production',offlineReadiness:null}),/DEV42_READINESS_INVALID/);
});
test('DEV42 refuses incomplete offline review',()=>{
  const x=evaluateDev42RuntimeContract({action:'STAGING_INTEGRATION',requestedEnvironment:'isolated-staging',offlineReadiness:{reviewStatus:'BLOCKED'}});
  assert.equal(x.decision,'DENY');
  assert.equal(x.reason,'NO_RUNTIME_AUTHORITY');
});
