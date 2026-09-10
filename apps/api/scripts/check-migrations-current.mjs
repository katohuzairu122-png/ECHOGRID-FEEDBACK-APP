#!/usr/bin/env node
/**
 * Migration drift guard -- fails when the Drizzle schema in src/db/schema/
 * has changes that no migration in drizzle/ accounts for.
 *
 * WHY THIS EXISTS
 * Block 7 of the Continuing Development work shipped a schema change with no
 * accompanying migration. Nothing caught it: typecheck passed, every unit
 * test passed (they use fake repositories, never a real database), and the
 * deploy succeeded. The damage only surfaced in production, where S4's
 * aggregation pipeline failed on every INSERT against a column the deployed
 * database did not have. This script closes that specific hole: a schema
 * change without its migration now fails CI at the same moment it is pushed,
 * not weeks later at runtime.
 *
 * HOW IT WORKS
 * `drizzle-kit generate` is already the source of truth for "is the migration
 * directory current?" -- run against an up-to-date schema it prints "No schema
 * changes, nothing to migrate" and writes nothing. So rather than
 * reimplementing Drizzle's diffing (which would drift from the real thing),
 * this hashes drizzle/ before and after a real generate run and fails if
 * anything appeared or changed.
 *
 * The working tree is always restored afterwards -- added files are removed,
 * modified files are written back byte-for-byte -- so this is safe to run
 * locally on a dirty branch, not just on a disposable CI checkout.
 *
 * NO DATABASE REQUIRED
 * `generate` diffs the TypeScript schema against drizzle/meta/*_snapshot.json;
 * it never opens a connection (only migrate/push/studio do). drizzle.config.ts
 * still reads DATABASE_URL at load time, so a syntactically valid placeholder
 * is supplied when the variable is absent. That is what lets this run as an
 * early CI step with no Postgres service attached.
 *
 * Deliberately plain .mjs, not .ts: it needs no compile step, no tsx, and no
 * place in the app's type surface (tsconfig.json includes only src/**\/*.ts).
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIZZLE_DIR = path.join(API_ROOT, 'drizzle');

/** Generous enough for a cold drizzle-kit start; short enough that a prompt
 * waiting on stdin (which we never provide) fails the build instead of
 * hanging the runner until GitHub's own 6-hour job timeout. */
const GENERATE_TIMEOUT_MS = 120_000;

function fail(message) {
  process.stderr.write(`\n[migration-drift] ${message}\n`);
  process.exit(1);
}

/** Recursively hash every file under dir, keyed by path relative to dir.
 * Returns an empty map if dir does not exist -- a repo with no migrations yet
 * is a valid starting state, not an error. */
function snapshotDir(dir) {
  const files = new Map();
  if (!fs.existsSync(dir)) return files;

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const contents = fs.readFileSync(full);
      files.set(path.relative(dir, full).split(path.sep).join('/'), {
        hash: createHash('sha256').update(contents).digest('hex'),
        contents,
      });
    }
  };

  walk(dir);
  return files;
}

/** Resolve drizzle-kit's executable through Node's own resolution rather than
 * node_modules/.bin or `pnpm exec`. Both of those are shell/platform
 * sensitive (.cmd shims on Windows, where this is also run by hand from Git
 * Bash); reading the package's declared bin and handing it to process.execPath
 * works identically everywhere. */
function resolveDrizzleKitBin() {
  // Located on disk rather than via require.resolve('drizzle-kit/package.json').
  // drizzle-kit ships an "exports" map that does not list "./package.json", so
  // that call throws ERR_PACKAGE_PATH_NOT_EXPORTED -- Node enforces the export
  // map for bare specifiers even when the file plainly exists. Walking
  // node_modules directly sidesteps the export map entirely, and also picks up
  // a root-hoisted install as well as apps/api's own.
  const searched = [];
  let pkgPath;

  for (let dir = API_ROOT; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', 'drizzle-kit', 'package.json');
    searched.push(candidate);
    if (fs.existsSync(candidate)) {
      pkgPath = candidate;
      break;
    }
    if (path.dirname(dir) === dir) break; // filesystem root
  }

  // Last resort: resolve the package's main entry (which the export map DOES
  // allow) and walk back up to the package.json sitting beside it. Covers
  // exotic layouts -- custom store paths, Yarn PnP-style resolution -- that a
  // plain node_modules walk would miss.
  if (!pkgPath) {
    try {
      let dir = path.dirname(createRequire(import.meta.url).resolve('drizzle-kit'));
      for (;;) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === 'drizzle-kit') {
          pkgPath = candidate;
          break;
        }
        if (path.dirname(dir) === dir) break;
        dir = path.dirname(dir);
      }
    } catch {
      // fall through to the failure below
    }
  }

  if (!pkgPath) {
    fail(`Cannot locate drizzle-kit. Run \`pnpm install\` first.\nLooked for:\n${searched.map((p) => `  ${p}`).join('\n')}`);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.['drizzle-kit'] ?? Object.values(pkg.bin ?? {})[0]);
  if (!bin) fail(`drizzle-kit ${pkg.version} declares no bin entry; cannot run generate.`);

  const binPath = path.resolve(path.dirname(pkgPath), bin);
  if (!fs.existsSync(binPath)) {
    fail(`drizzle-kit ${pkg.version} declares bin "${bin}" but ${binPath} does not exist.`);
  }

  return binPath;
}

/** Put drizzle/ back exactly as it was found, whatever generate did to it. */
function restore(before, after) {
  for (const relative of after.keys()) {
    const full = path.join(DRIZZLE_DIR, relative);
    const original = before.get(relative);
    if (!original) {
      fs.rmSync(full, { force: true });
    } else if (original.hash !== after.get(relative).hash) {
      fs.writeFileSync(full, original.contents);
    }
  }
  // generate does not delete, but restoring a vanished file costs one branch
  // and means this function is honestly a restore, not a best-effort cleanup.
  for (const [relative, original] of before) {
    const full = path.join(DRIZZLE_DIR, relative);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, original.contents);
    }
  }
}

const before = snapshotDir(DRIZZLE_DIR);

const result = spawnSync(process.execPath, [resolveDrizzleKitBin(), 'generate'], {
  cwd: API_ROOT,
  timeout: GENERATE_TIMEOUT_MS,
  encoding: 'utf8',
  // stdin ignored on purpose: drizzle-kit prompts interactively when it cannot
  // tell a rename from a drop/add. That ambiguity is itself drift, so the
  // right outcome is a failed check, never a stalled runner.
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    // Never connected to -- see the header note on why generate needs no DB.
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://ci:ci@127.0.0.1:5432/ci',
  },
});

const after = snapshotDir(DRIZZLE_DIR);
restore(before, after);

if (result.error?.code === 'ETIMEDOUT' || result.signal) {
  fail(
    `drizzle-kit generate did not finish within ${GENERATE_TIMEOUT_MS / 1000}s. ` +
      'It most likely stopped on an interactive rename prompt, which means the schema ' +
      'has an ambiguous change. Run `pnpm --filter @echo-grid-feedback/api db:generate` ' +
      'locally and answer it.',
  );
}

if (result.status !== 0) {
  process.stderr.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  fail(`drizzle-kit generate exited ${result.status}.`);
}

const added = [...after.keys()].filter((f) => !before.has(f));
const modified = [...after.keys()].filter((f) => before.has(f) && before.get(f).hash !== after.get(f).hash);

if (added.length === 0 && modified.length === 0) {
  process.stdout.write('[migration-drift] OK -- drizzle/ is up to date with src/db/schema/.\n');
  process.exit(0);
}

process.stderr.write('\n[migration-drift] Schema changes have no migration.\n\n');
for (const f of added) process.stderr.write(`  would create  drizzle/${f}\n`);
for (const f of modified) process.stderr.write(`  would modify  drizzle/${f}\n`);
process.stderr.write(
  '\nThe committed schema in src/db/schema/ no longer matches drizzle/. Deploying this\n' +
    'would run application code against columns/constraints the database does not have.\n\n' +
    'Fix:\n' +
    '  pnpm --filter @echo-grid-feedback/api db:generate\n' +
    '  git add apps/api/drizzle && git commit\n\n' +
    'Then apply it with db:migrate before or alongside the deploy (migrations are a\n' +
    'deliberate manual step -- see docs/DEPLOYMENT.md).\n',
);
process.exit(1);
