import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV36_PHASES } from './dev36-sandbox-test-plan.mjs';
import { assessDev38Readiness } from './dev38-readiness-aggregation.mjs';

const sha='a'.repeat(40);
const completeStatuses=Object.fromEntries(DEV36_PHASES.map(p=>[p.id,'PASS']));
const completeEvidence=DEV36_PHASES.map(p=>({phase:p.id,baselineSha:sha,result:'PASS',reference:'run/'+p.id}));
const good={baselineSha:sha,statuses:completeStatuses,evidence:completeEvidence,preflight:{status:'OFFLINE_PREFLIGHT_PASS'},manifest:{verdict:'SANDBOX_EVIDENCE_COMPLETE'}};

test('DEV38 complete offline record never authorizes execution',()=>{
  const x=assessDev38Readiness(good);
  assert.equal(x.verdict,'OFFLINE_RECORD_CONSISTENT');
  assert.equal(x.independentVerification,false);
  assert.equal(x.executionAuthorized,false);
  assert.equal(x.migrationAuthorized,false);
  assert.equal(x.deploymentAuthorized,false);
  assert.equal(x.financialAuthorization,'NOT_GRANTED');
});
test('DEV38 upstream failures block without advancing',()=>{
  assert.equal(assessDev38Readiness({...good,preflight:{status:'OFFLINE_PREFLIGHT_BLOCKED'}}).verdict,'BLOCKED');
  assert.equal(assessDev38Readiness({...good,manifest:{verdict:'NOT_READY'}}).verdict,'BLOCKED');
});
test('DEV38 missing required phase blocks',()=>{
  const statuses={...completeStatuses,'loyalty-redemption':'NOT_RUN'};
  const evidence=completeEvidence.filter(x=>x.phase!=='loyalty-redemption');
  assert.equal(assessDev38Readiness({...good,statuses,evidence}).verdict,'BLOCKED');
});
test('DEV38 unsupported PASS fails closed',()=>{
  assert.throws(()=>assessDev38Readiness({...good,evidence:[]}),/DEV37_PASS_UNSUPPORTED/);
});
