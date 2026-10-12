/**
 * Live PostgreSQL, NON-ACTIVATING verification. Run ONLY on a disposable
 * migrated database: SPLIT07_DISPOSABLE_DB=I_ACKNOWLEDGE DATABASE_URL=... node ...
 * No trigger disabling, schema modifications, economic inserts or commits.
 */
import assert from 'node:assert/strict';
import { Client } from 'pg';

if (process.env.SPLIT07_DISPOSABLE_DB !== 'I_ACKNOWLEDGE' || !process.env.DATABASE_URL)
  throw new Error('Disposable database acknowledgement and DATABASE_URL required');
const business='01234567-89ab-4def-8abc-0123456789ab';
const month='2026-10';
const key=`partner_credit_multiunit:${business}:${month}`;
const clients=Array.from({length:3},()=>new Client({connectionString:process.env.DATABASE_URL}));
const [a,b,c]=clients;
try {
  await Promise.all(clients.map(x=>x.connect()));
  const guards=['partner_credit_lots_inert_guard','partner_credit_ledger_insert_disabled',
    'partner_credit_reservations_inert_guard','pc_multiunit_allocation_inert_guard',
    'pc_multiunit_movement_inert_guard'];
  const result=await a.query('SELECT tgname,tgenabled FROM pg_trigger WHERE tgname = ANY($1::text[])',[guards]);
  assert.deepEqual(new Set(result.rows.filter(x=>x.tgenabled==='O').map(x=>x.tgname)),new Set(guards));
  const constraints=await a.query(`SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) AND convalidated`,
    [['pc_multiunit_exact_conservation','pc_multiunit_lot_once','pc_multiunit_decision_once',
      'partner_credit_multiunit_movements_idempotency_key_key']]);
  assert.equal(constraints.rowCount,4,'conservation/idempotency constraints must be validated');
  await a.query('BEGIN');
  await b.query('BEGIN');
  await c.query('BEGIN');
  await a.query('SELECT pc_multiunit_month_lock($1::uuid,$2)',[business,month]);
  const cannot=await Promise.all([b,c].map(x=>x.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key])));
  assert(cannot.every(x=>x.rows[0]?.acquired===false),'same business/month must exclude two contenders');
  // Different months must be independent across business branches.
  const independent=await b.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
    [`partner_credit_multiunit:${business}:2026-11`]);
  assert.equal(independent.rows[0]?.acquired,true);
  await a.query('ROLLBACK');
  const acquired=await c.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key]);
  assert.equal(acquired.rows[0]?.acquired,true,'rollback must release original transaction lock');
  await c.query('ROLLBACK');
  await b.query('ROLLBACK');
  // Repeatability: a subsequent transaction must regain the same lock.
  await b.query('BEGIN');
  await b.query('SELECT pc_multiunit_month_lock($1::uuid,$2)',[business,month]);
  await b.query('ROLLBACK');
  console.log('PASS: guard/constraint introspection, 3-client lock exclusion, rollback, isolation, reacquisition');
} finally {
  await Promise.allSettled(clients.map(x=>x.query('ROLLBACK')));
  await Promise.allSettled(clients.map(x=>x.end()));
}
