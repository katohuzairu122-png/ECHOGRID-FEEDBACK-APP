/**
 * Gate 2: manual, read-only verification of encrypted staging DATABASE_URL.
 * Intentionally NO SQL migrations or application writes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const hostAllowlist = new Set([
  'ep-sparkling-hall-au6p04ch.c-10.us-east-1.aws.neon.tech',
  'ep-sparkling-hall-au6p04ch-pooler.c-10.us-east-1.aws.neon.tech',
]);
const fail = (code) => { throw Error(code); };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.env.DATABASE_URL;
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GATE2_STAGING_PREFLIGHT !== 'VERIFY_STAGING_TARGET' ||
    !raw) fail('EXECUTION_GUARD_DENIED');
let parsed;
try { parsed = new URL(raw); } catch { fail('DATABASE_URL_PARSE_DENIED'); }
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !hostAllowlist.has(parsed.hostname) ||
    (parsed.port && parsed.port !== '5432') ||
    parsed.pathname !== '/neondb' ||
    !parsed.username || !parsed.password || parsed.hash) {
  fail('CONNECTION_TARGET_DENIED');
}
const options = new Set(['sslmode', 'channel_binding']);
if ([...parsed.searchParams.keys()].some(k => !options.has(k))) fail('URL_OPTIONS_DENIED');
const journal = JSON.parse(readFileSync(resolve(root,'drizzle/meta/_journal.json'),'utf8'));
if (journal.version !== '7' || journal.dialect !== 'postgresql' ||
    journal.entries.length !== 72 ||
    journal.entries[44].tag !== '0044_split07_multiunit_inert_conservation' ||
    journal.entries[45].tag !== '0045_heta01_f1_stripe_evidence' ||
    journal.entries[71].tag !== '0071_cashier_sessions') {
  fail('REPOSITORY_JOURNAL_DENIED');
}
const client = new pg.Client({
  connectionString: raw, connectionTimeoutMillis: 12000,
  statement_timeout: 15000, query_timeout: 15000,
});
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const id = (await client.query(
    "SELECT current_database() db, current_setting('server_version_num')::int version, current_setting('transaction_read_only') read_only"
  )).rows[0];
  if (id.db !== 'neondb' || Math.floor(id.version / 10000) !== 18 ||
      id.read_only !== 'on') fail('CONNECTED_IDENTITY_DENIED');
  const rows = (await client.query(
    'SELECT hash, created_at::text stamp FROM drizzle.__drizzle_migrations ORDER BY id'
  )).rows;
  if (rows.length !== 45) fail('JOURNAL_COUNT_DENIED');
  // Historical migrations were normalized after being applied. Drizzle
  // migrates by journal timestamp; the existing production verifier reports
  // historical hash matches without requiring all older file bytes to match.
  // Preserve stronger source integrity by pinning the complete historical
  // stored-hash+timestamp digest to the independently verified pre-migration
  // snapshot and the still-unmodified original staging branch.
  const knownHistoryDigest = '6182f1afca2008d5467db9eb931cedf6b517319a0990fe493e7a5533dc532a0d';
  const actualHistoryDigest = createHash('sha256').update(
    rows.map((row) => row.hash + ':' + row.stamp).join('\n'),
  ).digest('hex');
  if (actualHistoryDigest !== knownHistoryDigest) fail('HISTORICAL_JOURNAL_BASELINE_DENIED');
  let exactHashes = 0;
  for (let i=0; i<rows.length; i++) {
    const e = journal.entries[i];
    if (e.idx !== i || rows[i].stamp !== String(e.when)) fail('JOURNAL_TIMESTAMP_DENIED');
    const sql = readFileSync(resolve(root,'drizzle',e.tag+'.sql'),'utf8');
    const matches = rows[i].hash === createHash('sha256').update(sql).digest('hex');
    if (matches) exactHashes++;
    // The most recent applied migration was independently verified as exact.
    // Its unexpected drift must still stop the workflow.
    if (i === 44 && !matches) fail('LAST_APPLIED_MIGRATION_HASH_DENIED');
  }
  const guards = (await client.query(
    "SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname = ANY($1::text[])",
    [[
      'partner_credit_lots_inert_guard',
      'partner_credit_ledger_insert_disabled',
      'partner_credit_reservations_inert_guard',
      'pc_multiunit_allocation_inert_guard',
      'pc_multiunit_movement_inert_guard',
    ]]
  )).rows[0].n;
  if (guards !== 5) fail('FINANCIAL_GUARD_DENIED');
  await client.query('ROLLBACK');
  console.log(JSON.stringify({
    gate:'GATE2_STAGING_SECRET_READONLY',status:'PASS',
    targetEndpointAllowlisted:true,database:'neondb',postgresMajor:18,
    appliedMigrations:45,pendingMigrations:23,
    historicalStoredHashHistoryMatchesVerifiedSnapshot:true,
    exactRepositorySqlHashMatches:exactHashes,historicalSqlHashDifferences:45-exactHashes,
    mostRecentAppliedMigrationHashExact:true,
    financialGuardsEnabled:5,
    neonBranchIdIndependentlyVerified:false,
    runtimeRoleCertified:false,migrationExecuted:false,deploymentExecuted:false
  }));
} catch (error) {
  await client.query('ROLLBACK').catch(()=>undefined);
  // Never print driver errors: they may expose connection or SQL context.
  const codes = new Set([
    'CONNECTED_IDENTITY_DENIED','JOURNAL_COUNT_DENIED',
    'JOURNAL_TIMESTAMP_DENIED','HISTORICAL_JOURNAL_BASELINE_DENIED',
    'LAST_APPLIED_MIGRATION_HASH_DENIED','FINANCIAL_GUARD_DENIED'
  ]);
  console.error(codes.has(error?.message) ? error.message : 'PREFLIGHT_DATABASE_DENIED');
  process.exitCode=1;
} finally {
  await client.end().catch(()=>undefined);
}
