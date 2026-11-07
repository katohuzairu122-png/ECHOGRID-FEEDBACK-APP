import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDev37Evidence} from './dev37-evidence-crosscheck.mjs';

const sha='a'.repeat(40);
const record=(phase,override={})=>({phase,baselineSha:sha,result:'PASS',reference:'run/123',...override});
test('DEV37 accepts consistent offline evidence without granting authority',()=>{
  const r=validateDev37Evidence({baselineSha:sha,statuses:{baseline:'PASS',isolation:'PASS'},evidence:[record('baseline'),record('isolation')]});
  assert.equal(r.verdict,'OFFLINE_CROSSCHECK_PASS');
  assert.deepEqual(r.evidencePhases,['baseline','isolation']);
  assert.equal(r.independentlyVerified,false);
  assert.equal(r.integrationExecuted,false);
  assert.equal(r.deploymentAuthorized,false);
  assert.equal(r.financialAuthorization,'NOT_GRANTED');
});
test('DEV37 rejects a PASS with no evidence',()=>{
  assert.throws(()=>validateDev37Evidence({baselineSha:sha,statuses:{baseline:'PASS'},evidence:[]}),/DEV37_PASS_UNSUPPORTED/);
});
test('DEV37 rejects PASS with unsatisfied prerequisite',()=>{
  assert.throws(()=>validateDev37Evidence({baselineSha:sha,statuses:{isolation:'PASS'},evidence:[record('isolation')]}),/DEV37_PASS_UNSUPPORTED/);
});
test('DEV37 rejects duplicate, mismatched and orphan evidence',()=>{
  assert.throws(()=>validateDev37Evidence({baselineSha:sha,statuses:{baseline:'PASS'},evidence:[record('baseline'),record('baseline')]}),/DEV37_EVIDENCE_INVALID/);
  assert.throws(()=>validateDev37Evidence({baselineSha:sha,statuses:{baseline:'PASS'},evidence:[record('baseline',{baselineSha:'b'.repeat(40)})]}),/DEV37_EVIDENCE_INVALID/);
  assert.throws(()=>validateDev37Evidence({baselineSha:sha,statuses:{},evidence:[record('baseline')]}),/DEV37_ORPHAN_EVIDENCE/);
});
