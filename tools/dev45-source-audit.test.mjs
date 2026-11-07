import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDev45Source, runDev45SourceAudit } from './dev45-source-audit.mjs';

const fixtures = {
  workerSource: `async function queue() { if (message.body.type === 'classify_feedback') {} else if (message.body.type === 'generate_summary') {} else if (message.body.type === 'send_notification') {} else if (message.body.type === 'escalate_critical_incident') {} message.ack(); message.retry(); handleDeadLetterBatch(batch, env); } const DAILY_CRON = '0 0 * * *'; async function scheduled() { sweepExpiredOrphanSettlements(env); runStripeEvidenceHeartbeat(env, event.scheduledTime); }`,
  bindingsSource: 'export type PlatformJob = SentimentJob;',
  webhookSource: 'stripe-signature constructEvent',
  billingSource: 'stripe.checkout.sessions.create(',
};
test('DEV45 reports missing explicit unknown-job rejection without granting authority',()=>{
  const result=inspectDev45Source(fixtures);
  assert.equal(result.unrecognizedJobDisposition,'NO_EXPLICIT_REJECTION_OBSERVED');
  assert.equal(result.verdict,'SOURCE_SHAPE_ONLY_NOT_AUTHORIZED');
  assert.equal(result.financialAuthorizationGranted,false);
  assert.equal(result.stagingAuthorizationGranted,false);
  assert.equal(result.dispatch.length,4);
  assert.ok(result.dispatch.every(x=>x.observed));
});
test('DEV45 rejects missing source input',()=>{
  assert.throws(()=>inspectDev45Source({...fixtures,billingSource:''}),/DEV45_SOURCE_MISSING/);
});
test('DEV45 detects missing handler branch',()=>{
  const result=inspectDev45Source({...fixtures,workerSource:fixtures.workerSource.replace("message.body.type === 'send_notification'","message.body.type === 'other'")});
  assert.equal(result.dispatch.find(x=>x.type==='send_notification').observed,false);
});
test('DEV45 inspects repository files without executing application code',()=>{
  const result=runDev45SourceAudit();
  assert.equal(result.verdict,'SOURCE_SHAPE_ONLY_NOT_AUTHORIZED');
  assert.equal(result.dispatch.length,4);
  assert.ok(result.checks.some(x=>x.id==='ORPHAN_EXPIRY_CRON'));
});
