/**
 * Gate 2 PG18 disposable-only certification. READ ONLY queries.
 * Never certify any Neon or staging target with this script.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const EXPECTED_DB = 'echogrid_ci_pg18';
const EXPECTED_USER = 'echogrid';
const EXPECTED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid');
if (!EXPECTED_HOSTS.has(url.hostname) || decodeURIComponent(url.pathname.slice(1)) !== EXPECTED_DB ||
    decodeURIComponent(url.username) !== EXPECTED_USER || url.search || url.hash ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    process.env.GATE2_EPHEMERAL_PG18 !== 'I_ACKNOWLEDGE_DISPOSABLE_POSTGRES18') {
  throw new Error('GATE2_NON_DISPOSABLE_TARGET_DENIED');
}

const api = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = JSON.parse(readFileSync(resolve(api, 'drizzle/meta/_journal.json'), 'utf8')).entries;
const requiredGuards = [
  'partner_credit_lots_inert_guard',
  'partner_credit_ledger_insert_disabled',
  'partner_credit_reservations_inert_guard',
  'pc_multiunit_allocation_inert_guard',
  'pc_multiunit_movement_inert_guard',
  'settlement_custody_link_inert_guard',
];
const requiredRlsTables = [
  'partner_credit_settlement_authorizations',
  'stripe_read_authorizations',
  'stripe_read_authorization_events',
  'signed_evidence_records',
  'signed_evidence_events',
  'settlement_custody_authorization_links',
];
const requiredRoles = [
  'settlement_recorder', 'settlement_consumer', 'settlement_authority_reader',
  'stripe_read_auth_lifecycle', 'stripe_read_auth_auditor',
  'signed_evidence_lifecycle', 'signed_evidence_writer', 'signed_evidence_auditor',
];
const fail = (code) => { throw new Error('GATE2_PG18_' + code); };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await db.connect();
  const info = (await db.query("SELECT current_database() AS db, current_user AS role, current_setting('server_version_num')::int AS version")).rows[0];
  if (info.db !== EXPECTED_DB || info.role !== EXPECTED_USER || Math.floor(info.version / 10000) !== 18) fail('WRONG_DATABASE_OR_VERSION');

  const applied = (await db.query('SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
  if (entries.length !== 68 || applied.length !== entries.length ||
      applied.some((row, index) => row.created_at !== String(entries[index].when))) fail('JOURNAL_MISMATCH');

  const guards = (await db.query(
    "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname = ANY($1::text[])",
    [requiredGuards],
  )).rows.map(r => r.tgname);
  if (requiredGuards.some(x => !guards.includes(x))) fail('INERT_GUARD_MISSING');

  const rls = (await db.query(
    "SELECT relname FROM pg_class JOIN pg_namespace n ON n.oid = relnamespace WHERE n.nspname = 'public' AND relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity",
    [requiredRlsTables],
  )).rows.map(r => r.relname);
  if (requiredRlsTables.some(x => !rls.includes(x))) fail('REQUIRED_RLS_NOT_FORCED');

  const roles = (await db.query(
    'SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = ANY($1::text[])',
    [requiredRoles],
  )).rows;
  if (requiredRoles.some(name => !roles.some(r => r.rolname === name &&
      !r.rolcanlogin && !r.rolsuper && !r.rolbypassrls && !r.rolcreaterole))) fail('LEAST_PRIVILEGE_ROLE_MISSING');

  console.log(JSON.stringify({
    gate: 'GATE2_PG18_DISPOSABLE_CLEAN_REPLAY',
    status: 'PASS',
    source: 'LOCAL_EPHEMERAL_CI_ONLY',
    postgresMajor: 18,
    appliedMigrations: applied.length,
    inertGuardsPresent: requiredGuards.length,
    forcedRlsTables: requiredRlsTables.length,
    leastPrivilegeRoles: requiredRoles.length,
    stagingVerified: false,
    productionVerified: false,
    migrationAuthorized: false,
    financialAuthorization: 'NOT_GRANTED',
  }));
} finally {
  await db.end().catch(() => undefined);
}
