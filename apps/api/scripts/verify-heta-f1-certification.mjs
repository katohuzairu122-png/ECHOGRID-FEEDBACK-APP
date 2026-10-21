/**
 * HETA-01-F1 clean-database certification (manual workflow only; see .github/workflows/heta-f1-certification.yml).
 *
 *   node scripts/verify-heta-f1-certification.mjs guard     before migrating: target pinning, TLS, empty baseline
 *   node scripts/verify-heta-f1-certification.mjs certify   after migrating: journal-derived history, guards, catalog
 *
 * Reads DATABASE_URL, EXPECTED_HOST and EXPECTED_DATABASE from the environment. Never prints the URL or any credential
 * (only the non-secret host and database name). It never writes to the database and never disables anything.
 * It certifies a CLEAN migration replay of the repository's journal; it does NOT certify tenant isolation, RLS, roles,
 * historical-tier authority or any provider completeness, and it activates nothing.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CERT_DB_PATTERN = /^echogrid_heta01_f1_cert_[a-z0-9_]{1,40}$/;
/** H.4: the completed Split 07 certification database and every shared database name must never be (re)used here. */
export const FORBIDDEN_DATABASES = ['neondb', 'postgres', 'echogrid_split07_cert_clean'];
export const GUARD_TRIGGERS = [
  'partner_credit_lots_inert_guard',
  'partner_credit_ledger_insert_disabled',
  'partner_credit_reservations_inert_guard',
  'pc_multiunit_allocation_inert_guard',
  'pc_multiunit_movement_inert_guard',
];
export const GUARD_CONSTRAINTS = [
  'pc_multiunit_exact_conservation',
  'pc_multiunit_lot_once',
  'pc_multiunit_decision_once',
  'partner_credit_multiunit_movements_idempotency_key_key',
];
export const LOCAL_TEST_ACK = 'I_ACKNOWLEDGE_LOCAL_DISPOSABLE';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(here, '..');
const CONTRACT_PATH = path.resolve(API, '../../docs/architecture/builds/SPLIT-07/stripe-evidence-contract.json');

/** Pure. Returns the list of failure codes for a connection URL against the expected host and database. */
export function checkTarget(urlString, expected, { localTest = false } = {}) {
  const failures = [];
  let u;
  try {
    u = new URL(urlString || '');
  } catch {
    return ['URL_INVALID'];
  }
  const localHost = ['localhost', '127.0.0.1'].includes(u.hostname);
  const relaxed = localTest === true && localHost; // only ever for a local disposable server
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) failures.push('PROTOCOL');
  if (!expected?.host || !/^[a-z0-9.-]+$/.test(expected.host)) failures.push('EXPECTED_HOST_INVALID');
  else if (u.hostname !== expected.host) failures.push('HOST_MISMATCH');
  if (u.hostname.includes('-pooler')) failures.push('POOLED_ENDPOINT');
  if (!relaxed && !u.hostname.endsWith('.neon.tech')) failures.push('HOST_NOT_NEON');
  const db = decodeURIComponent(u.pathname.slice(1));
  if (!expected?.database || !CERT_DB_PATTERN.test(expected.database)) failures.push('EXPECTED_DATABASE_INVALID');
  else if (db !== expected.database) failures.push('DATABASE_MISMATCH');
  if (FORBIDDEN_DATABASES.includes(db)) failures.push('DATABASE_FORBIDDEN');
  if (!CERT_DB_PATTERN.test(db)) failures.push('DATABASE_PATTERN');
  if (u.port && u.port !== '5432' && !relaxed) failures.push('PORT');
  if (!relaxed && u.searchParams.get('sslmode') !== 'require') failures.push('SSLMODE');
  if (u.searchParams.has('options')) failures.push('OPTIONS_PARAMETER');
  // node-postgres lets query parameters (host, hostaddr, dbname, user, port, ssl, service, ...) override the URL authority and
  // takes the LAST duplicate where URL.searchParams.get takes the first. Fail closed: sslmode is the only permitted key and it
  // may appear at most once, so the validated authority is the authority pg connects to.
  for (const key of new Set(u.searchParams.keys())) if (key !== 'sslmode' && key !== 'options') failures.push('QUERY_PARAMETER_NOT_ALLOWED');
  if (u.searchParams.getAll('sslmode').length > 1) failures.push('SSLMODE_DUPLICATE');
  return [...new Set(failures)];
}

/** Pure. Compares the applied migration history and catalog to the repository journal and the evidence contract. */
export function evaluateCertification({ journal, applied, triggers, constraints, catalog, contract }) {
  const failures = [];
  if (applied.length !== journal.length) failures.push(`COUNT_MISMATCH(applied=${applied.length},journal=${journal.length})`);
  for (let i = 0; i < Math.min(applied.length, journal.length); i++) {
    if (Number(applied[i].createdAt) !== journal[i].when) failures.push(`ORDER_MISMATCH(index=${i},tag=${journal[i].tag})`);
    if (applied[i].hash !== journal[i].sha256) failures.push(`HASH_MISMATCH(index=${i},tag=${journal[i].tag})`);
  }
  for (const name of GUARD_TRIGGERS) {
    const t = triggers.find(x => x.tgname === name);
    if (!t) failures.push(`GUARD_MISSING(${name})`);
    else if (t.tgenabled !== 'O') failures.push(`GUARD_NOT_ENABLED(${name})`);
  }
  for (const name of GUARD_CONSTRAINTS) {
    const c = constraints.find(x => x.conname === name);
    if (!c) failures.push(`CONSTRAINT_MISSING(${name})`);
    else if (!c.convalidated) failures.push(`CONSTRAINT_NOT_VALIDATED(${name})`);
  }
  for (const [table, want] of Object.entries(contract.tables)) {
    const got = catalog[table];
    if (!got) { failures.push(`CATALOG_TABLE_MISSING(${table})`); continue; }
    for (const aspect of ['columns', 'checks', 'uniques', 'foreignKeys', 'indexes', 'triggers']) {
      if (JSON.stringify(got[aspect]) !== JSON.stringify(want[aspect])) failures.push(`CATALOG_DRIFT(${table}.${aspect})`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Journal entries with the sha256 of each SQL file, exactly as Drizzle records it. */
export function readJournal(apiDir = API) {
  const j = JSON.parse(readFileSync(path.join(apiDir, 'drizzle/meta/_journal.json'), 'utf8'));
  return j.entries.map(e => ({
    tag: e.tag,
    when: e.when,
    sha256: createHash('sha256').update(readFileSync(path.join(apiDir, 'drizzle', `${e.tag}.sql`), 'utf8')).digest('hex'),
  }));
}

export function readContract() {
  return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
}

async function catalogOf(db, tables) {
  const out = {};
  for (const table of tables) {
    const exists = (await db.query('select to_regclass($1) is not null as e', [`public.${table}`])).rows[0].e;
    if (!exists) continue;
    const names = async (sql) => (await db.query(sql, [table])).rows.map(r => r.n);
    out[table] = {
      columns: await names(`select a.attname n from pg_attribute a where a.attrelid=('public.'||$1)::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`),
      checks: await names(`select conname n from pg_constraint where conrelid=('public.'||$1)::regclass and contype='c' order by conname`),
      uniques: await names(`select conname n from pg_constraint where conrelid=('public.'||$1)::regclass and contype='u' order by conname`),
      foreignKeys: await names(`select conname n from pg_constraint where conrelid=('public.'||$1)::regclass and contype='f' order by conname`),
      indexes: await names(`select indexname n from pg_indexes where schemaname='public' and tablename=$1 and indexname not like '%_pkey' order by indexname`),
      triggers: await names(`select tgname n from pg_trigger where tgrelid=('public.'||$1)::regclass and not tgisinternal order by tgname`),
    };
  }
  return out;
}

async function main() {
  const phase = process.argv[2];
  if (phase !== 'guard' && phase !== 'certify') throw new Error('usage: verify-heta-f1-certification.mjs guard|certify');
  const expected = { host: process.env.EXPECTED_HOST, database: process.env.EXPECTED_DATABASE };
  const localTest = process.env.HETA_F1_CERT_LOCAL_TEST === LOCAL_TEST_ACK;
  const targetFailures = checkTarget(process.env.DATABASE_URL, expected, { localTest });
  if (targetFailures.length) {
    console.log(JSON.stringify({ phase, ok: false, failures: targetFailures.map(f => `TARGET_${f}`) }));
    process.exitCode = 2;
    return;
  }
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    const target = { host: expected.host, database: expected.database };
    const name = (await db.query('select current_database() n')).rows[0].n;
    if (name !== expected.database) throw new Error('connected database does not equal the expected database');
    if (phase === 'guard') {
      const ssl = (await db.query('select coalesce((select ssl from pg_stat_ssl where pid=pg_backend_pid()), false) as ssl')).rows[0].ssl;
      const base = (await db.query("select (select count(*)::int from information_schema.tables where table_schema='public') as tables, to_regclass('drizzle.__drizzle_migrations') as journal")).rows[0];
      const failures = [];
      if (!ssl && !localTest) failures.push('TLS_NOT_IN_USE');
      if (base.tables !== 0) failures.push(`NOT_EMPTY(public_tables=${base.tables})`);
      if (base.journal !== null) failures.push('NOT_EMPTY(migration_journal_exists)');
      console.log(JSON.stringify({ phase, ok: failures.length === 0, ...target, tls: ssl, failures }));
      process.exitCode = failures.length ? 2 : 0;
      return;
    }
    const journal = readJournal();
    const contract = readContract();
    const applied = (await db.query('select hash, created_at from drizzle.__drizzle_migrations order by id')).rows.map(r => ({ hash: r.hash, createdAt: r.created_at }));
    const triggers = (await db.query('select tgname, tgenabled from pg_trigger where not tgisinternal and tgname = any($1::text[])', [GUARD_TRIGGERS])).rows;
    const constraints = (await db.query('select conname, convalidated from pg_constraint where conname = any($1::text[])', [GUARD_CONSTRAINTS])).rows;
    const catalog = await catalogOf(db, Object.keys(contract.tables));
    const result = evaluateCertification({ journal, applied, triggers, constraints, catalog, contract });
    console.log(JSON.stringify({
      phase, ok: result.ok, ...target, migrations: applied.length, journalEntries: journal.length, guards: triggers.filter(t => t.tgenabled === 'O').length,
      constraints: constraints.filter(c => c.convalidated).length, evidenceTables: Object.keys(catalog).length, failures: result.failures,
      scope: 'clean migration replay only; not tenant isolation, RLS, roles, tier authority or provider completeness',
    }));
    process.exitCode = result.ok ? 0 : 2;
  } finally {
    await db.end().catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('certification script error:', e instanceof Error ? e.name : 'Error'); // never echo messages: they can contain connection details
    process.exitCode = 1;
  });
}
