/**
 * Disposable PostgreSQL-only integration check.
 * Run: DATABASE_URL=<disposable-db> node scripts/test-split07-lock-concurrency.mjs
 * Requires migration 0044. Creates no economic records and changes no guards.
 */
import { Client } from 'pg';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL for a disposable migrated PostgreSQL database is required');
}
const key = 'partner_credit_multiunit:01234567-89ab-4def-8abc-0123456789ab:2026-10';
const a = new Client({connectionString:process.env.DATABASE_URL});
const b = new Client({connectionString:process.env.DATABASE_URL});
try {
  await Promise.all([a.connect(),b.connect()]);
  await a.query('BEGIN');
  await b.query('BEGIN');
  await a.query(
    "SELECT pc_multiunit_month_lock($1::uuid,$2)",
    ['01234567-89ab-4def-8abc-0123456789ab','2026-10'],
  );
  const blocked = await b.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key],
  );
  assert.equal(blocked.rows[0]?.acquired,false,
    'second transaction must not obtain the business/month lock');
  await a.query('ROLLBACK');
  const after = await b.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key],
  );
  assert.equal(after.rows[0]?.acquired,true,
    'rollback must release the lock for subsequent transactions');
  await b.query('ROLLBACK');
  console.log('PASS: business/month lock excludes competing transaction and releases on rollback');
} finally {
  await Promise.allSettled([a.query('ROLLBACK'),b.query('ROLLBACK')]);
  await Promise.allSettled([a.end(),b.end()]);
}
