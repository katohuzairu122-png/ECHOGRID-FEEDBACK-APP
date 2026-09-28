import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const command = process.argv[2] ?? 'verify';
const allowed = new Set(['preflight', 'verify', 'e2e', 'evidence']);
const artifactDir = resolve(root, '.artifacts/block14');
const artifactPath = resolve(artifactDir, `${command}.json`);
const startedAt = new Date().toISOString();
const steps = [];

function pnpm() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function run(name, program, args, options = {}) {
  process.stdout.write(`\n[block14] ${name}\n`);
  const started = Date.now();
  const windowsCommand = process.platform === 'win32' && program.endsWith('.cmd');
  const result = spawnSync(
    windowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : program,
    windowsCommand ? ['/d', '/s', '/c', [program, ...args].join(' ')] : args,
    {
      cwd: options.cwd ?? root,
      env: process.env,
      encoding: 'utf8',
      stdio: options.capture ? 'pipe' : 'inherit',
      shell: false,
    },
  );
  const exitCode = result.error ? 1 : (result.status ?? 1);
  steps.push({
    name,
    command: [program, ...args].join(' '),
    status: exitCode === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    ...(result.error ? { error: result.error.message } : {}),
  });
  if (options.capture && result.stdout) process.stdout.write(result.stdout);
  if (options.capture && result.stderr) process.stderr.write(result.stderr);
  if (exitCode !== 0) throw new Error(`${name} failed with exit code ${exitCode}`);
  return (result.stdout ?? '').trim();
}

function check(name, assertion) {
  const started = Date.now();
  try {
    const detail = assertion();
    steps.push({ name, status: 'passed', durationMs: Date.now() - started, detail });
  } catch (error) {
    steps.push({
      name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function requireDatabase() {
  return check('Database configured', () => {
    const value = process.env.DATABASE_URL;
    if (!value) throw new Error('DATABASE_URL is required for integration verification');
    const database = new URL(value);
    const local = ['localhost', '127.0.0.1', '::1'].includes(database.hostname);
    if (!local && process.env.BLOCK14_ALLOW_REMOTE_DATABASE !== 'yes') {
      throw new Error('Refusing a remote database without BLOCK14_ALLOW_REMOTE_DATABASE=yes');
    }
    return `${database.hostname}/${database.pathname.slice(1)}`;
  });
}

function preflight() {
  run('pnpm available', pnpm(), ['--version'], { capture: true });
  run('Git repository available', 'git', ['rev-parse', '--show-toplevel'], { capture: true });
  check('Required E2E files', () => {
    const files = [
      'apps/api/vitest.integration.config.ts',
      'apps/web/playwright.config.ts',
      'apps/web/playwright.remote.config.ts',
      'apps/web/e2e/branch-management.spec.ts',
      'apps/web/e2e/loyalty.spec.ts',
      'apps/web/e2e/qr-engagement.spec.ts',
    ];
    for (const file of files) readFileSync(resolve(root, file));
    return `${files.length} files present`;
  });
  const remote = process.env.E2E_BASE_URL?.trim();
  if (remote) {
    check('Remote E2E target', () => new URL(remote).origin);
  } else {
    requireDatabase();
    check('Local API secrets', () => {
      const path = resolve(root, 'apps/api/.dev.vars');
      if (!existsSync(path)) throw new Error('apps/api/.dev.vars is required for local E2E');
      return path;
    });
  }
  check('Playwright dependency installed', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'apps/web/node_modules/@playwright/test/package.json'), 'utf8'),
    );
    return manifest.version;
  });
}

function e2e() {
  preflight();
  const remote = Boolean(process.env.E2E_BASE_URL?.trim());
  run(
    remote
      ? 'Playwright against explicit remote target'
      : 'Playwright against isolated local stack',
    pnpm(),
    remote
      ? ['--filter', '@echo-grid-feedback/web', 'test:e2e:remote']
      : ['--filter', '@echo-grid-feedback/web', 'test:e2e'],
  );
}

function verify() {
  preflight();
  if (process.env.E2E_BASE_URL?.trim()) requireDatabase();
  run('API integration tests', pnpm(), ['--filter', '@echo-grid-feedback/api', 'test:integration']);
  const remote = Boolean(process.env.E2E_BASE_URL?.trim());
  run(
    remote
      ? 'Playwright against explicit remote target'
      : 'Playwright against isolated local stack',
    pnpm(),
    remote
      ? ['--filter', '@echo-grid-feedback/web', 'test:e2e:remote']
      : ['--filter', '@echo-grid-feedback/web', 'test:e2e'],
  );
}

function evidence() {
  const verification = resolve(artifactDir, 'verify.json');
  check('Successful verification evidence exists', () => {
    const parsed = JSON.parse(readFileSync(verification, 'utf8'));
    if (parsed.status !== 'passed') throw new Error('Block 14 verification has not passed');
    return verification;
  });
}

function writeEvidence(status, error) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        block: '2D',
        command,
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        target: process.env.E2E_BASE_URL?.trim() || 'local-isolated-stack',
        ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
        steps,
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\n[block14] Evidence: ${artifactPath}\n`);
}

try {
  if (!allowed.has(command)) throw new Error(`Unknown Block 14 command: ${command}`);
  ({ preflight, verify, e2e, evidence })[command]();
  writeEvidence('passed');
} catch (error) {
  writeEvidence('failed', error);
  process.stderr.write(`\n[block14] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

