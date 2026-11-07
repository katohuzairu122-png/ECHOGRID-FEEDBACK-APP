import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV36_PHASES } from './dev36-sandbox-test-plan.mjs';
import { finalizeDev40OfflineReview,formatDev40OfflineReviewMarkdown } from './dev40-offline-review.mjs';

const sha='a'.repeat(40);
const input={
 baselineSha:sha,
 statuses:Object.fromEntries(DEV36_PHASES.map(p=>[p.id,'PASS'])),
 evidence:DEV36_PHASES.map(p=>({phase:p.id,baselineSha:sha,result:'PASS',reference:'run/'+p.id})),
 preflight:{status:'OFFLINE_PREFLIGHT_PASS'},
 manifest:{verdict:'SANDBOX_EVIDENCE_COMPLETE'},
};
const review={baselineSha:sha,decision:'APPROVED_FOR_FUTURE_STAGING_REVIEW',evidenceReviewed:true,reviewerReference:'review/123'};

test('DEV40 records offline review without authorizing execution',()=>{
 const x=finalizeDev40OfflineReview(input,review);
 assert.equal(x.reviewStatus,'READY_FOR_SEPARATE_STAGING_AUTHORIZATION');
 assert.equal(x.reviewerIdentityAuthenticated,false);
 assert.equal(x.evidenceIndependentlyVerifiedBySystem,false);
 assert.equal(x.stagingExecutionAuthorized,false);
 assert.equal(x.migrationExecuted,false);
 assert.equal(x.deploymentAuthorized,false);
 assert.equal(x.financialAuthorization,'NOT_GRANTED');
 assert.match(formatDev40OfflineReviewMarkdown(x),/Migrations executed: NO/);
});
test('DEV40 missing review evidence or rejected decision blocks',()=>{
 assert.equal(finalizeDev40OfflineReview(input,{...review,evidenceReviewed:false}).reviewStatus,'BLOCKED');
 assert.equal(finalizeDev40OfflineReview(input,{...review,decision:'REJECTED'}).reviewStatus,'BLOCKED');
});
test('DEV40 mismatched baseline and invalid reviewer data fail closed',()=>{
 assert.throws(()=>finalizeDev40OfflineReview(input,{...review,baselineSha:'b'.repeat(40)}),/DEV40_BASELINE_MISMATCH/);
 assert.throws(()=>finalizeDev40OfflineReview(input,{...review,reviewerReference:'secret value with spaces'}),/DEV40_REVIEW_INVALID/);
});
test('DEV40 incomplete upstream record blocks review',()=>{
 assert.equal(finalizeDev40OfflineReview({...input,manifest:{verdict:'NOT_READY'}},review).reviewStatus,'BLOCKED');
});
