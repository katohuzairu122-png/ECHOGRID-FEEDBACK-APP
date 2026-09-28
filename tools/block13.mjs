import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const command = process.argv[2] ?? 'full';
const allowedCommands = new Set(['preflight', 'quick', 'full', 'changed']);
const evidencePath = resolve(
  root,
  process.env.BLOCK13_EVIDENCE_PATH ?? `.artifacts/block13/${command}.json`,
);
const startedAt = new Date().toISOString();
const steps = [];

function executable(name) {
  return process.platform === 'win32' && name === 'pnpm' ? `${name}.cmd` : name;
}

function run(name, program, args, options = {}) {
  const started = Date.now();
  process.stdout.write(`\n[block13] ${name}\n`);
  const isWindowsCommand = process.platform === 'win32' && program.endsWith('.cmd');
  const invokedProgram = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : program;
  const invokedArgs = isWindowsCommand
    ? ['/d', '/s', '/c', [program, ...args].join(' ')]
    : args;
  const result = spawnSync(invokedProgram, invokedArgs, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
  });
  const status = result.error ? 1 : (result.status ?? 1);
  steps.push({
    name,
    command: [program, ...args].join(' '),
    status: status === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    ...(result.error ? { error: result.error.message } : {}),
  });
  if (options.capture && result.stdout) process.stdout.write(result.stdout);
  if (options.capture && result.stderr) process.stderr.write(result.stderr);
  if (status !== 0) throw new Error(`${name} failed with exit code ${status}`);
  return (result.stdout ?? '').trim();
}

function record(name, check) {
  const started = Date.now();
  try {
    const detail = check();
    steps.push({ name, status: 'passed', durationMs: Date.now() - started, detail });
  } catch (error) {
    steps.push({ name, status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function major(version) {
  return Number(version.replace(/^v/, '').split('.')[0]);
}

function preflight() {
  record('Supported command', () => command);
  record('Node.js 22 or newer', () => {
    if (major(process.version) < 22) throw new Error(`Node.js ${process.version} is unsupported`);
    return process.version;
  });
  const pnpmVersion = run('pnpm available', executable('pnpm'), ['--version'], { capture: true });
  record('pnpm 11 or newer', () => {
    if (major(pnpmVersion) < 11) throw new Error(`pnpm ${pnpmVersion} is unsupported`);
    return pnpmVersion;
  });
  const repositoryRoot = run('Git repository available', executable('git'), ['rev-parse', '--show-toplevel'], { capture: true });
  record('Required repository files', () => {
    const required = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/package.json', 'apps/web/package.json', 'packages/shared-types/package.json'];
    for (const file of required) readFileSync(resolve(root, file));
    return `${required.length} files present; repository ${repositoryRoot}`;
  });
  run('Frozen dependency graph', executable('pnpm'), ['install', '--frozen-lockfile', '--lockfile-only']);
}

function quick() {
  preflight();
  run('Migration drift check', executable('pnpm'), ['--filter', '@echo-grid-feedback/api', 'db:check']);
  run('Lint', executable('pnpm'), ['lint']);
  run('Typecheck', executable('pnpm'), ['typecheck']);
}

function full() {
  quick();
  run('Unit tests', executable('pnpm'), ['test']);
  run('Production builds', executable('pnpm'), ['build']);
}

function changedFiles() {
  const explicitBase = process.env.BLOCK13_BASE;
  const base = explicitBase ?? 'HEAD~1';
  let files;
  try {
    files = run(`Changed files since ${base}`, executable('git'), ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], { capture: true });
  } catch (error) {
    if (explicitBase) throw error;
    files = run('Changed files in initial commit', executable('git'), ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { capture: true });
  }
  return files.split(/\r?\n/u).filter(Boolean);
}

function changed() {
  preflight();
  const files = changedFiles();
  const affectsAll = files.some((file) => file === 'pnpm-lock.yaml' || file === 'pnpm-workspace.yaml' || file.startsWith('packages/shared-types/'));
  const api = affectsAll || files.some((file) => file.startsWith('apps/api/'));
  const web = affectsAll || files.some((file) => file.startsWith('apps/web/'));
  record('Test selection', () => JSON.stringify({ base: process.env.BLOCK13_BASE ?? 'HEAD~1', files, api, web }));
  if (!api && !web) {
    process.stdout.write('\n[block13] No application files changed; no targeted suites selected.\n');
    return;
  }
  if (api) run('Changed API tests', executable('pnpm'), ['--filter', '@echo-grid-feedback/api', 'test']);
  if (web) run('Changed web tests', executable('pnpm'), ['--filter', '@echo-grid-feedback/web', 'test']);
}

function writeEvidence(status, error) {
  const evidence = {
    schemaVersion: 1,
    block: '2C',
    command,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
    steps,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`\n[block13] Evidence: ${evidencePath}\n`);
}

try {
  if (!allowedCommands.has(command)) throw new Error(`Unknown Block 13 command: ${command}`);
  ({ preflight, quick, full, changed })[command]();
  writeEvidence('passed');
} catch (error) {
  writeEvidence('failed', error);
  process.stderr.write(`\n[block13] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
