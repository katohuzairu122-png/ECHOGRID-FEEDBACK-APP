/**
 * Gate 2 R3 — synthetic 45-to-71 migration upgrade on a disposable PG18
 * GitHub Actions service container. No Neon resources or customer data.
 *
 * Commands: prepare | verify-prefix | verify-full
 * "prepare" edits ONLY the disposable runner's checked-out journal file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const command = process.argv[2];
if (!['prepare', 'verify-prefix', 'verify-full'].includes(command)) throw new Error('GATE2_COMMAND_INVALID');
const expectedUrl = 'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_upgrade';
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GATE2_SYNTHETIC_UPGRADE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
    process.env.DATABASE_URL !== expectedUrl) {
  throw new Error('GATE2_DISPOSABLE_TARGET_DENIED');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const journalPath = resolve(root, 'drizzle/meta/_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
if (journal.version !== '7' || journal.dialect !== 'postgresql' ||
    !Array.isArray(journal.entries) ||
    ![45, 71].includes(journal.entries.length) ||
    journal.entries.some((e, i) => e.idx !== i ||
      !e.tag.startsWith(String(i).padStart(4, '0') + '_') ||
      !Number.isSafeInteger(e.when))) throw new Error('GATE2_JOURNAL_INVALID');

const expectedFromGit = JSON.parse((await import('node:child_process')).execFileSync(
  'git', ['show', 'HEAD:apps/api/drizzle/meta/_journal.json'],
  { cwd: root, encoding: 'utf8' },
));
if (expectedFromGit.entries.length !== 71 ||
    expectedFromGit.entries[44].tag !== '0044_split07_multiunit_inert_conservation' ||
    expectedFromGit.entries[45].tag !== '0045_heta01_f1_stripe_evidence' ||
    expectedFromGit.entries[70].tag !== '0070_platform_customer_limited_access') {
  throw new Error('GATE2_FULL_JOURNAL_UNEXPECTED');
}
const expected = expectedFromGit.entries;
if (journal.entries.some((e, i) => e.tag !== expected[i].tag || e.when !== expected[i].when))
  throw new Error('GATE2_JOURNAL_TAMPERED');

if (command === 'prepare') {
  if (journal.entries.length !== 71) throw new Error('GATE2_ALREADY_TRUNCATED');
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 45) }, null, 2) + '\n');
  console.log('GATE2 synthetic 45-entry journal prepared locally; repository and Neon databases unchanged');
} else {
  if ((command === 'verify-prefix' && journal.entries.length !== 45) ||
      (command === 'verify-full' && journal.entries.length !== 71)) throw new Error('GATE2_WRONG_PHASE');
  const client = new pg.Client({ connectionString: expectedUrl });
  try {
    await client.connect();
    const current = (await client.query(
      "SELECT current_database() db, current_user role, current_setting('server_version_num')::int version",
    )).rows[0];
    if (current.db !== 'echogrid_ci_pg18_upgrade' || current.role !== 'echogrid' ||
        Math.floor(current.version / 10000) !== 18) throw new Error('GATE2_PG18_TARGET_MISMATCH');
    const rows = (await client.query(
      'SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    )).rows;
    const count = command === 'verify-prefix' ? 45 : 71;
    if (rows.length !== count || rows.some((r, i) => r.created_at !== String(expected[i].when)))
      throw new Error('GATE2_APPLIED_MIGRATIONS_MISMATCH');

    if (command === 'verify-prefix') {
      const prior = (await client.query(
        "SELECT to_regclass('public.signed_evidence_records')::text AS signed_evidence",
      )).rows[0];
      if (prior.signed_evidence !== null) throw new Error('GATE2_FUTURE_SCHEMA_PRESENT');
    } else {
      const names = [
        'partner_credit_settlement_authorizations',
        'stripe_read_authorizations',
        'signed_evidence_records',
        'signed_evidence_events',
        'settlement_custody_authorization_links',
      ];
      const secured = (await client.query(
        "SELECT relname FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity",
        [names],
      )).rows.map(r => r.relname);
      if (names.some(n => !secured.includes(n))) throw new Error('GATE2_POST_UPGRADE_RLS_MISSING');
      const requiredGuards = [
        'partner_credit_lots_inert_guard',
        'partner_credit_ledger_insert_disabled',
        'partner_credit_reservations_inert_guard',
        'pc_multiunit_allocation_inert_guard',
        'pc_multiunit_movement_inert_guard',
        'settlement_custody_link_inert_guard',
      ];
      const enabled = (await client.query(
        "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname = ANY($1::text[])",
        [requiredGuards],
      )).rows.map(r => r.tgname);
      if (requiredGuards.some(n => !enabled.includes(n))) throw new Error('GATE2_POST_UPGRADE_GUARDS_MISSING');
    }
    console.log(JSON.stringify({
      gate:'GATE2_PG18_SYNTHETIC_UPGRADE', phase:command,
      result:'PASS', appliedMigrations:count,
      stagingVerified:false, stagingMigrated:false, deploymentAuthorized:false,
      financialAuthorization:'NOT_GRANTED',
    }));
  } finally { await client.end().catch(() => undefined); }
}
