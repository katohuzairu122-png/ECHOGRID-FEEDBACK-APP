import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV36_PHASES } from './dev36-sandbox-test-plan.mjs';
import { generateDev39ReadinessReport, formatDev39ReadinessMarkdown } from './dev39-readiness-report.mjs';

const sha='a'.repeat(40);
const statuses=Object.fromEntries(DEV36_PHASES.map(p=>[p.id,'PASS']));
const evidence=DEV36_PHASES.map(p=>({phase:p.id,baselineSha:sha,result:'PASS',reference:'run/'+p.id}));
const input={baselineSha:sha,statuses,evidence,preflight:{status:'OFFLINE_PREFLIGHT_PASS'},manifest:{verdict:'SANDBOX_EVIDENCE_COMPLETE'}};

test('DEV39 creates deterministic report without authorizing action',()=>{
  const report=generateDev39ReadinessReport(input);
  assert.equal(report.verdict,'OFFLINE_RECORD_CONSISTENT');
  assert.equal(report.independentlyVerified,false);
  assert.equal(report.stagingExecutionAuthorized,false);
  assert.equal(report.migrationAuthorized,false);
  assert.equal(report.deploymentAuthorized,false);
  assert.equal(report.financialAuthorization,'NOT_GRANTED');
  assert.deepEqual(report,generateDev39ReadinessReport(input));
  assert.match(formatDev39ReadinessMarkdown(report),/Migrations authorized: NO/);
});
test('DEV39 reports blocked gate without raw evidence leakage',()=>{
  const report=generateDev39ReadinessReport({...input,manifest:{verdict:'NOT_READY'}});
  assert.equal(report.verdict,'BLOCKED');
  const rendered=formatDev39ReadinessMarkdown(report);
  assert.doesNotMatch(rendered,/run\/baseline/);
  assert.match(rendered,/Independent evidence review/);
});
test('DEV39 rejects invalid baseline and unsupported PASS',()=>{
  assert.throws(()=>generateDev39ReadinessReport({...input,baselineSha:'invalid'}),/DEV39_INPUT_INVALID/);
  assert.throws(()=>generateDev39ReadinessReport({...input,evidence:[]}),/DEV37_PASS_UNSUPPORTED/);
});
