import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const command = process.argv[2] ?? 'verify';
const allowed = new Set(['preflight', 'audit', 'verify-static', 'verify', 'evidence']);
const artifactDir = resolve(root, '.artifacts/block18');
const artifactPath = resolve(artifactDir, `${command}.json`);
const apiUrl = process.env.BLOCK18_API_URL?.trim();
const webUrl = process.env.BLOCK18_WEB_URL?.trim();
const releaseVersion = process.env.BLOCK18_RELEASE_VERSION?.trim();
const commit = (process.env.BLOCK18_GIT_COMMIT ?? process.env.GITHUB_SHA)?.trim();
const startedAt = new Date().toISOString();
const steps = [];

function text(path) { return readFileSync(resolve(root, path), 'utf8'); }
function record(name, fn) {
  const started = Date.now();
  return Promise.resolve().then(fn).then((detail) => {
    steps.push({ name, status: 'passed', durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(`\n[block18] PASS ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}\n`);
    return detail;
  }).catch((error) => {
    steps.push({ name, status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
}
function requireTargets() {
  if (!apiUrl || !webUrl) throw new Error('BLOCK18_API_URL and BLOCK18_WEB_URL are required');
  const api = new URL(apiUrl); const web = new URL(webUrl);
  if (api.protocol !== 'https:' || web.protocol !== 'https:') throw new Error('Block 18 targets must use HTTPS');
  return { api, web };
}
function jsonFiles(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir)) { const path = join(dir, entry); if (statSync(path).isDirectory()) jsonFiles(path, output); else if (entry.endsWith('.json')) output.push(path); }
  return output;
}
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

async function preflight() {
  await record('Final release files', () => {
    const files = ['pnpm-lock.yaml', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'docs/LAUNCH-READINESS.md', 'docs/RELEASE-OWNERSHIP.md', '.github/workflows/ci-cd.yml'];
    for (const file of files) text(file);
    return `${files.length} release files present`;
  });
  await record('Proprietary license is explicit', () => {
    const pkg = JSON.parse(text('package.json'));
    if (pkg.license !== 'UNLICENSED' || pkg.private !== true) throw new Error('Private proprietary package metadata changed');
    if (!/proprietary and confidential/i.test(text('LICENSE'))) throw new Error('Proprietary license notice missing');
    return 'private package; all rights reserved';
  });
}

async function audit() {
  await preflight();
  await record('Previous block controls are wired', () => {
    const pkg = JSON.parse(text('package.json'));
    for (const script of ['block14:e2e', 'block15:evidence', 'block16:evidence', 'block17:evidence']) if (!pkg.scripts?.[script]) throw new Error(`Missing predecessor gate ${script}`);
    const workflow = text('.github/workflows/ci-cd.yml');
    for (const job of ['block-2e-runtime:', 'block-2f-release:', 'block-2g-commercial:']) if (!workflow.includes(job)) throw new Error(`Workflow missing ${job}`);
    return 'E2E, hardening, operations, and commercial gates ordered';
  });
  await record('Security and release ownership', () => {
    if (!/0 Critical, 0 High/.test(text('docs/SECURITY-REVIEW.md'))) throw new Error('Security review has unresolved critical/high findings');
    const owners = text('docs/RELEASE-OWNERSHIP.md');
    for (const field of ['Release decision owner', 'Deployment owner', 'Rollback owner', 'Incident commander']) if (!owners.includes(field)) throw new Error(`Ownership missing: ${field}`);
    return 'no critical/high findings; release and rollback roles assigned';
  });
  await record('Go/no-go criteria are explicit', () => {
    const readiness = text('docs/LAUNCH-READINESS.md');
    for (const marker of ['Technical GO', 'Public launch authorization', 'NO-GO conditions', 'Rollback triggers']) if (!readiness.includes(marker)) throw new Error(`Launch decision missing ${marker}`);
    return 'technical release and owner launch authorization separated';
  });
}

async function verifyStatic() { await audit(); }

async function verify() {
  const { api, web } = requireTargets();
  await record('Final API release probe', async () => {
    const response = await globalThis.fetch(new URL('/health', api), { signal: globalThis.AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'ok') throw new Error(`API probe returned ${response.status}`);
    return `${response.status} ok`;
  });
  await record('Final web release probe', async () => {
    const response = await globalThis.fetch(web, { signal: globalThis.AbortSignal.timeout(15000) });
    const body = await response.text();
    if (!response.ok || body.length < 100) throw new Error(`Web probe returned ${response.status}`);
    return { status: response.status, bytes: body.length };
  });
}

async function evidence() {
  if (!releaseVersion || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) throw new Error('BLOCK18_RELEASE_VERSION must be a semantic version such as v0.1.0-rc.1');
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error('BLOCK18_GIT_COMMIT/GITHUB_SHA must be a full commit SHA');
  await record('All predecessor evidence passed', () => {
    const expected = ['2D', '2E', '2F', '2G']; const found = new Set();
    for (const path of jsonFiles(resolve(root, '.artifacts'))) {
      let data; try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
      if (expected.includes(data.block) && data.status === 'passed') found.add(data.block);
    }
    const missing = expected.filter((block) => !found.has(block));
    if (missing.length) throw new Error(`Missing passing evidence for ${missing.join(', ')}`);
    return `passing evidence found for ${expected.join(', ')}`;
  });
  await record('Immutable evidence manifest', () => {
    const files = {};
    for (const path of jsonFiles(resolve(root, '.artifacts')).filter((path) => !path.startsWith(artifactDir))) files[relative(root, path).replaceAll('\\', '/')] = sha256(path);
    if (Object.keys(files).length < 4) throw new Error('Evidence manifest is incomplete');
    const attestation = { schemaVersion: 1, releaseVersion, commit, decision: 'TECHNICAL_GO', publicLaunchAuthorization: 'REQUIRED_SEPARATELY', generatedAt: new Date().toISOString(), algorithm: 'sha256', files };
    mkdirSync(artifactDir, { recursive: true }); writeFileSync(resolve(artifactDir, 'release-attestation.json'), `${JSON.stringify(attestation, null, 2)}\n`);
    return `${Object.keys(files).length} evidence files hashed`;
  });
}

function writeEvidence(status, error) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify({ schemaVersion: 1, block: '2H', command, status, startedAt, completedAt: new Date().toISOString(), releaseVersion: releaseVersion ?? null, commit: commit ?? null, targets: { api: apiUrl ?? null, web: webUrl ?? null }, steps, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }, null, 2)}\n`);
  process.stdout.write(`\n[block18] Evidence: ${artifactPath}\n`);
}

try {
  if (!allowed.has(command)) throw new Error(`Unknown Block 18 command: ${command}`);
  await ({ preflight, audit, 'verify-static': verifyStatic, verify, evidence })[command](); writeEvidence('passed');
} catch (error) {
  writeEvidence('failed', error); process.stderr.write(`\n[block18] ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
}

