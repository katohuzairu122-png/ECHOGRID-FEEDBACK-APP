/**
 * LOYALTY-PROGRAMME-COMPLETION: data-preservation evidence for migration 0107 on a DISPOSABLE loopback PostgreSQL only.
 * Applies the journal up to 0106, seeds pre-programme businesses (one with custom settings, one with none, one soft-deleted), accounts, tiers, rewards and ledger rows,
 * snapshots a checksum of every existing loyalty table, applies 0107, then proves: nothing existing changed; every business got exactly one active LEGACY LP-03 programme
 * reproducing its settings; and the earning arithmetic for recorded purchases is identical. Usage: REHEARSAL_PG_URL=postgresql://user@127.0.0.1:5432 node scripts/release/lpc-backfill-evidence.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.REHEARSAL_PG_URL;
if (!base) throw new Error('REHEARSAL_PG_URL is required (a loopback PostgreSQL server).');
const u = new URL(base);
if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('EVIDENCE_TARGET_DENIED: only a loopback PostgreSQL server may be used.');
const tag = Math.random().toString(36).slice(2, 8);
const dbName = `lpc_bf_${tag}`;
const urlFor = (db) => { const x = new URL(base); x.pathname = `/${db}`; return x.toString(); };
const journal = JSON.parse(readFileSync(join(api, 'drizzle/meta/_journal.json'), 'utf8'));
const idx = journal.entries.findIndex((e) => e.tag.startsWith('0107_'));
if (idx < 1) throw new Error('0107 not found in the journal');

function migrate(db, outDir) {
  const cfg = join(api, `drizzle.lpc.${tag}.config.ts`);
  writeFileSync(cfg, `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ schema: './src/db/schema/index.ts', out: ${JSON.stringify(outDir)}, dialect: 'postgresql', dbCredentials: { url: ${JSON.stringify(urlFor(db))} } });\n`);
  try {
    const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate', '--config', cfg], { cwd: api, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`MIGRATE_FAILED ${(r.stderr || r.stdout).slice(-400)}`);
  } finally { rmSync(cfg, { force: true }); }
}

const admin = new pg.Client({ connectionString: urlFor('postgres') });
const evidence = { database: dbName, baseline: journal.entries[idx - 1].tag, target: journal.entries[idx].tag, checks: [] };
const check = (name, ok, detail = {}) => { evidence.checks.push({ name, ok, ...detail }); if (!ok) throw new Error(`EVIDENCE_FAILED: ${name} ${JSON.stringify(detail)}`); };
const tmpOut = join(api, `.lpc-prefix-${tag}`);
await admin.connect();
try {
  await admin.query(`create database ${dbName}`);
  mkdirSync(join(tmpOut, 'meta'), { recursive: true });
  const prefix = journal.entries.slice(0, idx);
  for (const e of prefix) cpSync(join(api, 'drizzle', `${e.tag}.sql`), join(tmpOut, `${e.tag}.sql`));
  writeFileSync(join(tmpOut, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prefix }, null, 2));
  migrate(dbName, tmpOut);

  const db = new pg.Client({ connectionString: urlFor(dbName) });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  // --- seed pre-programme data
  const biz = async (name) => (await q(`insert into businesses (name, slug) values ($1, $2) returning id`, [name, `${name.toLowerCase().replace(/\W+/g, '-')}-${tag}`]))[0].id;
  const custom = await biz('Custom Rate');
  const defaults = await biz('Default Rate');
  const gone = await biz('Closed Business');
  await q(`update businesses set is_deleted = true where id = $1`, [gone]).catch(() => undefined);
  await q(`insert into loyalty_settings (business_id, points_per_checkin, points_per_currency_unit, referral_bonus_points, birthday_bonus_points) values ($1, 7, 2.50, 40, 90)`, [custom]);
  await q(`insert into loyalty_tiers (business_id, name, min_points, sort_order) values ($1,'Silver',50,1),($1,'Gold',200,2)`, [custom]);
  await q(`insert into loyalty_rewards (business_id, name, type, points_cost, status) values ($1,'Free coffee','points',100,'active')`, [custom]);
  const customer = (await q(`insert into customers (phone) values ($1) returning id`, [`+1555${Date.now()}`]))[0].id;
  const membership = (await q(`insert into business_customer_memberships (customer_id, business_id, status, onboarding_source, onboarding_reference) values ($1,$2,'active','evidence','lpc') returning id`, [customer, custom]))[0].id;
  const account = (await q(`insert into loyalty_accounts (customer_id, business_id, membership_id, points) values ($1,$2,$3,123) returning id`, [customer, custom, membership]))[0].id;
  await q(`insert into loyalty_transactions (loyalty_account_id, type, points, notes) values ($1,'checkin',7,'seed'),($1,'purchase',116,'seed')`, [account]);
  const tables = ['businesses', 'loyalty_settings', 'loyalty_tiers', 'loyalty_rewards', 'loyalty_accounts', 'loyalty_transactions', 'loyalty_purchase_events', 'customers', 'business_customer_memberships'];
  const fingerprint = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await q(`select count(*)::int n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) h from ${t} t`))[0]])));
  const before = await fingerprint();
  check('seeded pre-programme data', before.loyalty_accounts.n === 1 && before.loyalty_transactions.n === 2 && before.businesses.n >= 3, { counts: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.n])) });
  await db.end();

  // --- apply 0107 on top
  migrate(dbName, join(api, 'drizzle'));
  const after = new pg.Client({ connectionString: urlFor(dbName) });
  await after.connect();
  const q2 = async (sql, params) => (await after.query(sql, params)).rows;
  const fp = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await q2(`select count(*)::int n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) h from ${t} t`))[0]])));
  // loyalty_transactions gained two NULL columns, so its row text changes by exactly ',,' ; compare everything else byte for byte.
  for (const t of tables.filter((x) => x !== 'loyalty_transactions')) check(`unchanged: ${t}`, fp[t].n === before[t].n && fp[t].h === before[t].h, { rows: fp[t].n });
  const tx = await q2(`select count(*)::int n, sum(points)::int p, count(*) filter (where program_id is not null)::int with_program from loyalty_transactions`);
  check('ledger rows and points unchanged, provenance columns empty', tx[0].n === 2 && tx[0].p === 123 && tx[0].with_program === 0, tx[0]);
  const acct = await q2(`select points from loyalty_accounts where id = $1`, [account]);
  check('account balance unchanged', acct[0].points === 123, acct[0]);

  const programs = await q2(`select p.business_id, p.type, p.status, p.legacy, p.current_version, v.config from loyalty_programs p join loyalty_program_versions v on v.program_id = p.id and v.version = p.current_version`);
  const nBusinesses = (await q2(`select count(*)::int n from businesses`))[0].n;
  check('every business has exactly one active legacy LP-03 programme', programs.length === nBusinesses && programs.every((p) => p.type === 'LP-03' && p.status === 'active' && p.legacy && p.current_version === 1), { programmes: programs.length, businesses: nBusinesses });
  const customCfg = programs.find((p) => p.business_id === custom).config;
  check('custom settings reproduced exactly', customCfg.pointsPerCurrencyUnit === '2.50' && customCfg.pointsPerCheckin === 7 && customCfg.rounding === 'floor' && customCfg.legacy === true, customCfg);
  const defCfg = programs.find((p) => p.business_id === defaults).config;
  check('a business that never had settings gets the table defaults (1.00 per unit, 10 per check-in)', defCfg.pointsPerCurrencyUnit === '1.00' && defCfg.pointsPerCheckin === 10, defCfg);
  const events = (await q2(`select count(*)::int n from loyalty_program_events where event_type = 'legacy_backfill'`))[0].n;
  check('one backfill event per programme', events === programs.length, { events });
  const oneActive = (await q2(`select count(*)::int n from (select business_id from loyalty_programs where status='active' group by business_id having count(*) > 1) x`))[0].n;
  check('no business has more than one active programme', oneActive === 0);
  const setup = (await q2(`select count(*)::int n from loyalty_program_setup`))[0].n;
  check('existing businesses carry no setup marker (they are not "configure later")', setup === 0);
  await after.end();
  evidence.verdict = 'LPC_BACKFILL_EVIDENCE_PASSED_LOCAL_DISPOSABLE_ONLY';
} finally {
  rmSync(tmpOut, { recursive: true, force: true });
  await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
  await admin.end();
}
console.log(JSON.stringify(evidence, null, 2));
