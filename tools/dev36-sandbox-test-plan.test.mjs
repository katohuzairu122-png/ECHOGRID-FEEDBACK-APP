import test from 'node:test';
import assert from 'node:assert/strict';
import {DEV36_PHASES,planDev36Sandbox} from './dev36-sandbox-test-plan.mjs';

test('DEV36 blocks integration steps until upstream evidence passes',()=>{
  const result=planDev36Sandbox(DEV36_PHASES,{});
  assert.equal(result.phases[0].eligibleForFutureManualTest,true);
  assert.equal(result.phases.find(x=>x.id==='staging-schema').eligibleForFutureManualTest,false);
  assert.equal(result.phases.find(x=>x.id==='stripe-sandbox').eligibleForFutureManualTest,false);
  assert.equal(result.integrationExecuted,false);
  assert.equal(result.migrationsExecuted,false);
  assert.equal(result.deploymentAuthorized,false);
  assert.equal(result.financialAuthorization,'NOT_GRANTED');
});
test('DEV36 unlocks only explicitly satisfied dependency paths',()=>{
  const statuses={baseline:'PASS',isolation:'PASS',configuration:'PASS'};
  const result=planDev36Sandbox(DEV36_PHASES,statuses);
  assert.equal(result.phases.find(x=>x.id==='migration-approval').eligibleForFutureManualTest,true);
  assert.equal(result.phases.find(x=>x.id==='staging-schema').eligibleForFutureManualTest,false);
  assert.equal(result.phases.find(x=>x.id==='stripe-sandbox').eligibleForFutureManualTest,false);
});
test('DEV36 fails closed on cyclic or missing dependencies',()=>{
  assert.throws(()=>planDev36Sandbox([{id:'a',dependencies:['b']},{id:'b',dependencies:['a']}],{}),/DEV36_CYCLE_INVALID/);
  assert.throws(()=>planDev36Sandbox([{id:'a',dependencies:['missing']}],{}),/DEV36_DEPENDENCY_INVALID/);
  assert.throws(()=>planDev36Sandbox(DEV36_PHASES,{baseline:'UNVERIFIED'}),/DEV36_STATUS_INVALID/);
});
