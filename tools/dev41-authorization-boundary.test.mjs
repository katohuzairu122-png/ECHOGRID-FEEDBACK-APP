import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV36_PHASES } from './dev36-sandbox-test-plan.mjs';
import { evaluateDev41ExecutionBoundary } from './dev41-authorization-boundary.mjs';

const sha='a'.repeat(40);
const input={
  baselineSha:sha,
  statuses:Object.fromEntries(DEV36_PHASES.map(p=>[p.id,'PASS'])),
  evidence:DEV36_PHASES.map(p=>({phase:p.id,baselineSha:sha,result:'PASS',reference:'run/'+p.id})),
  preflight:{status:'OFFLINE_PREFLIGHT_PASS'},
  manifest:{verdict:'SANDBOX_EVIDENCE_COMPLETE'},
};
const review={baselineSha:sha,decision:'APPROVED_FOR_FUTURE_STAGING_REVIEW',evidenceReviewed:true,reviewerReference:'review/123'};

for (const action of ['STAGING_INTEGRATION','DATABASE_MIGRATION','DEPLOYMENT','FINANCIAL_OPERATION']) {
  test('DEV41 denies '+action+' even when offline review passes',()=>{
    const x=evaluateDev41ExecutionBoundary(input,review,action);
    assert.equal(x.offlineReviewStatus,'READY_FOR_SEPARATE_STAGING_AUTHORIZATION');
    assert.equal(x.decision,'DENIED');
    assert.equal(x.reason,'SEPARATE_EXPLICIT_AUTHORIZATION_REQUIRED');
    assert.equal(x.authorizationSource,'NONE');
    assert.equal(x.externalVerificationPerformed,false);
    assert.equal(x.integrationExecuted,false);
    assert.equal(x.migrationExecuted,false);
    assert.equal(x.deploymentExecuted,false);
    assert.equal(x.financialOperationExecuted,false);
  });
}
test('DEV41 blocks an incomplete review without escalating authority',()=>{
  const x=evaluateDev41ExecutionBoundary({...input,manifest:{verdict:'NOT_READY'}},review,'STAGING_INTEGRATION');
  assert.equal(x.decision,'DENIED');
  assert.equal(x.reason,'OFFLINE_REVIEW_BLOCKED');
});
test('DEV41 rejects unrecognized actions',()=>{
  assert.throws(()=>evaluateDev41ExecutionBoundary(input,review,'PRODUCTION_OVERRIDE'),/DEV41_ACTION_INVALID/);
});
test('DEV41 propagates baseline mismatch as fail-closed',()=>{
  assert.throws(()=>evaluateDev41ExecutionBoundary(input,{...review,baselineSha:'b'.repeat(40)},'DATABASE_MIGRATION'),/DEV40_BASELINE_MISMATCH/);
});
