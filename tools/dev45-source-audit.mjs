import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * DEV-45: offline source-shape audit, not a security enforcement control.
 * Paths resolve from repository root. Does not execute application modules.
 */
export function inspectDev45Source({ workerSource, bindingsSource, webhookSource, billingSource }) {
  for (const value of [workerSource, bindingsSource, webhookSource, billingSource]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('DEV45_SOURCE_MISSING');
  }
  const jobs = ['classify_feedback','generate_summary','send_notification','escalate_critical_incident'];
  const dispatch = jobs.map(type => ({
    type, observed: workerSource.includes(`message.body.type === '${type}'`),
  }));
  const queueStart = workerSource.indexOf('async function queue(');
  const queueEnd = workerSource.indexOf('const DAILY_CRON', queueStart);
  const queueSection = queueStart >= 0 ? workerSource.slice(queueStart, queueEnd >= 0 ? queueEnd : undefined) : '';
  const checks = [
    {id:'QUEUE_DISPATCH',observed:queueStart >= 0},
    {id:'QUEUE_DEAD_LETTER',observed:queueSection.includes('handleDeadLetterBatch(batch, env)')},
    {id:'QUEUE_RETRY',observed:queueSection.includes('message.retry(')},
    {id:'QUEUE_ACK',observed:queueSection.includes('message.ack()')},
    {id:'QUEUE_UNKNOWN_TYPE_REJECTION',observed:/else\s*\{\s*(?:throw|message\.retry|return)/.test(queueSection.slice(queueSection.indexOf("message.body.type === 'escalate_critical_incident'")))},
    {id:'SCHEDULED_CONSUMER',observed:workerSource.includes('async function scheduled(')},
    {id:'ORPHAN_EXPIRY_CRON',observed:workerSource.includes('sweepExpiredOrphanSettlements(env)')},
    {id:'STRIPE_HEARTBEAT_CRON',observed:workerSource.includes('runStripeEvidenceHeartbeat(env, event.scheduledTime)')},
    {id:'STRIPE_WEBHOOK_SIGNATURE',observed:webhookSource.includes('stripe-signature') && webhookSource.includes('constructEvent')},
    {id:'STRIPE_CHECKOUT_WRITE',observed:billingSource.includes('checkout.sessions.create(')},
    {id:'TYPED_QUEUE_UNION',observed:bindingsSource.includes('export type PlatformJob =')},
  ];
  return Object.freeze({
    schemaVersion:'dev45.source-audit.v1',
    dispatch,
    checks,
    unrecognizedJobDisposition:checks.find(x=>x.id==='QUEUE_UNKNOWN_TYPE_REJECTION')?.observed ? 'EXPLICIT_REJECTION_OBSERVED' : 'NO_EXPLICIT_REJECTION_OBSERVED',
    verdict:'SOURCE_SHAPE_ONLY_NOT_AUTHORIZED',
    financialAuthorizationGranted:false,
    stagingAuthorizationGranted:false,
  });
}

export function runDev45SourceAudit(root=process.cwd()) {
  const read=path=>readFileSync(resolve(root,path),'utf8');
  return inspectDev45Source({
    workerSource:read('apps/api/src/index.ts'),
    bindingsSource:read('apps/api/src/config/env.ts'),
    webhookSource:read('apps/api/src/billing/stripe-webhook.routes.ts'),
    billingSource:read('apps/api/src/billing/billing.service.ts'),
  });
}
if (process.argv[1]?.endsWith('dev45-source-audit.mjs')) {
  console.log(JSON.stringify(runDev45SourceAudit(),null,2));
}
