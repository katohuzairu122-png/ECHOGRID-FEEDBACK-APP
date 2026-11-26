/**
 * G10 LOCAL release rehearsal on DISPOSABLE databases only (no Neon, Cloudflare or remote branch; refuses any non-loopback server). Verifies, with real `drizzle-kit migrate`:
 *   1. clean install of the whole journal (ledger rows == journal entries);
 *   2. prefix upgrade: apply the journal up to a baseline (default: the first 88 entries = 0000-0087, the shared-environment baseline), then the full journal on top;
 *   3. runtime-role manifest drift check;
 *   4. rollback rehearsal: every committed Tentaship rollback file, newest first, on a clone of the fresh install (restores the previous guards; nothing shared is touched).
 * Usage:  REHEARSAL_PG_URL=postgresql://user:pass@localhost:5432 node scripts/release/local-release-rehearsal.mjs [--prefix 88]
 * Output: a JSON evidence summary. It does NOT authorise or perform any staging or production step.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.REHEARSAL_PG_URL;
if (!base) throw new Error('REHEARSAL_PG_URL is required (a loopback PostgreSQL server).');
const u = new URL(base);
if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('REHEARSAL_TARGET_DENIED: only a loopback PostgreSQL server may be used.');
const prefixArg = process.argv.indexOf('--prefix'); const PREFIX = prefixArg > -1 ? Number(process.argv[prefixArg + 1]) : 88;
const tag = Math.random().toString(36).slice(2, 8); const names = { fresh: `rh_fresh_${tag}`, prefix: `rh_prefix_${tag}`, rb: `rh_rollback_${tag}` };
const urlFor = (db) => { const x = new URL(base); x.pathname = `/${db}`; return x.toString(); };
const journal = JSON.parse(readFileSync(join(api, 'drizzle/meta/_journal.json'), 'utf8'));
const evidence = { journalEntries: journal.entries.length, lastMigration: journal.entries.at(-1).tag, prefix: PREFIX, steps: [] };

const admin = new pg.Client({ connectionString: urlFor('postgres') });
async function ledger(db) { const c = new pg.Client({ connectionString: urlFor(db) }); await c.connect(); try { return Number((await c.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0].n); } finally { await c.end(); } }
function migrate(db, outDir) {
  const cfg = join(api, `drizzle.rehearsal.${tag}.config.ts`);
  writeFileSync(cfg, `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ schema: './src/db/schema/index.ts', out: ${JSON.stringify(outDir)}, dialect: 'postgresql', dbCredentials: { url: ${JSON.stringify(urlFor(db))} }, strict: true });\n`);
  try { const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate', '--config', cfg], { cwd: api, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`MIGRATE_FAILED ${db}: ${(r.stderr || r.stdout).slice(-600)}`); }
  finally { rmSync(cfg, { force: true }); }
}
const step = (name, ok, detail = {}) => { evidence.steps.push({ name, ok, ...detail }); if (!ok) throw new Error(`REHEARSAL_STEP_FAILED: ${name} ${JSON.stringify(detail)}`); };

await admin.connect();
const tmpOut = join(api, `.rehearsal-prefix-${tag}`);
try {
  for (const n of Object.values(names)) await admin.query(`create database ${n}`);
  // 1. clean install
  migrate(names.fresh, join(api, 'drizzle'));
  step('clean install', (await ledger(names.fresh)) === journal.entries.length, { ledgerRows: await ledger(names.fresh) });
  // 2. prefix upgrade
  mkdirSync(join(tmpOut, 'meta'), { recursive: true });
  const prefixEntries = journal.entries.slice(0, PREFIX);
  for (const e of prefixEntries) cpSync(join(api, 'drizzle', `${e.tag}.sql`), join(tmpOut, `${e.tag}.sql`));
  writeFileSync(join(tmpOut, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prefixEntries }, null, 2));
  migrate(names.prefix, tmpOut);
  const afterPrefix = await ledger(names.prefix); step('prefix baseline applied', afterPrefix === PREFIX, { ledgerRows: afterPrefix, last: prefixEntries.at(-1).tag });
  migrate(names.prefix, join(api, 'drizzle'));
  const afterUpgrade = await ledger(names.prefix); step('upgrade from baseline to head', afterUpgrade === journal.entries.length, { ledgerRows: afterUpgrade });
  // 3. runtime-role drift
  const rr = spawnSync('node', ['scripts/runtime-role/generate.mjs', '--check'], { cwd: api, encoding: 'utf8' }); step('runtime-role manifest check', rr.status === 0, { output: (rr.stdout || rr.stderr).trim().slice(-120) });
  // 4. rollback rehearsal on a clone of the fresh install
  await admin.query(`drop database ${names.rb}`); await admin.query(`create database ${names.rb} template ${names.fresh}`);
  const rbDir = resolve(api, '../../docs/architecture/builds/TENTASHIP/rollback');
  const files = readdirSync(rbDir).filter((f) => /^\d{4}.*rollback\.sql$/.test(f)).sort().reverse();
  const c = new pg.Client({ connectionString: urlFor(names.rb) }); await c.connect();
  try { for (const f of files) { await c.query(readFileSync(join(rbDir, f), 'utf8')); step(`rollback ${f}`, true); } } finally { await c.end(); }
  evidence.verdict = 'REHEARSAL_PASSED_LOCAL_DISPOSABLE_ONLY';
} catch (e) { evidence.verdict = 'REHEARSAL_FAILED'; evidence.error = String(e.message ?? e); process.exitCode = 1; }
finally {
  rmSync(tmpOut, { recursive: true, force: true });
  for (const n of Object.values(names)) await admin.query(`drop database if exists ${n} with (force)`).catch(() => undefined);
  await admin.end();
}
console.log(JSON.stringify(evidence, null, 2));
