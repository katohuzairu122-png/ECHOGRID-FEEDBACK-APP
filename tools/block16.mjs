import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname);
const command = process.argv[2] ?? 'verify';
const allowed = new Set(['preflight', 'env-audit', 'manifest', 'smoke', 'verify', 'evidence']);
const artifactDir = resolve(root, '.artifacts/block16');
const artifactPath = resolve(artifactDir, `${command}.json`);
const manifestPath = resolve(artifactDir, 'release-manifest.json');
const startedAt = new Date().toISOString();
const steps = [];
const apiUrl = process.env.BLOCK16_API_URL?.trim();
const webUrl = process.env.BLOCK16_WEB_URL?.trim();

function record(name, fn) {
  const started = Date.now();
  return Promise.resolve().then(fn).then((detail) => {
    steps.push({ name, status: 'passed', durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(`\n[block16] PASS ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}\n`);
    return detail;
  }).catch((error) => {
    steps.push({ name, status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
}

function text(path) { return readFileSync(resolve(root, path), 'utf8'); }
function requireTargets() {
  if (!apiUrl || !webUrl) throw new Error('BLOCK16_API_URL and BLOCK16_WEB_URL are required');
  const api = new URL(apiUrl); const web = new URL(webUrl);
  if (api.protocol !== 'https:' || web.protocol !== 'https:') throw new Error('Block 16 targets must use HTTPS');
  return { api, web };
}
async function fetchTimed(url, init) {
  const started = performance.now();
  const response = await globalThis.fetch(url, { redirect: 'follow', ...init, signal: globalThis.AbortSignal.timeout(15000) });
  return { response, durationMs: Math.round(performance.now() - started) };
}

async function preflight() {
  await record('Required release files', () => {
    const files = ['pnpm-lock.yaml', 'apps/api/wrangler.toml', 'apps/web/wrangler.toml', 'docs/DEPLOYMENT.md', 'docs/OPERATIONS.md', '.github/workflows/ci-cd.yml'];
    for (const file of files) text(file);
    return `${files.length} files present`;
  });
  await record('Rollback procedure is actionable', () => {
    const deployment = text('docs/DEPLOYMENT.md');
    const operations = text('docs/OPERATIONS.md');
    if (!/wrangler rollback/.test(deployment) || !/apps\/api/.test(deployment) || !/apps\/web/.test(deployment)) throw new Error('Deployment rollback must cover both Workers');
    if (!/forward[- ]fix/i.test(deployment + operations) || !/migration/i.test(deployment + operations)) throw new Error('Database forward-fix policy is missing');
    return 'Worker rollback and database forward-fix documented';
  });
}

async function envAudit() {
  await preflight();
  await record('Production Worker configuration', () => {
    const api = text('apps/api/wrangler.toml'); const web = text('apps/web/wrangler.toml');
    const combined = `${api}\n${web}`;
    const placeholders = [/your[-_]/i, /replace[-_ ]me/i, /example\.com/i, /<[^>]+>/];
    const found = placeholders.filter((pattern) => pattern.test(combined)).map(String);
    if (found.length) throw new Error(`Placeholder production configuration found: ${found.join(', ')}`);
    for (const marker of ['[[hyperdrive]]', '[[r2_buckets]]', '[[kv_namespaces]]', '[[queues.producers]]', '[ai]', '[observability]']) if (!api.includes(marker)) throw new Error(`API binding missing: ${marker}`);
    for (const marker of ['[vars]', 'API_BASE_URL', 'APP_URL', '[assets]', '[observability]']) if (!web.includes(marker)) throw new Error(`Web configuration missing: ${marker}`);
    if (!/ALLOWED_ORIGINS\s*=\s*"https:\/\//.test(api) || !/WEB_BASE_URL\s*=\s*"https:\/\//.test(api)) throw new Error('API production origins must use HTTPS');
    if (!/API_BASE_URL\s*=\s*"https:\/\//.test(web) || !/APP_URL\s*=\s*"https:\/\//.test(web)) throw new Error('Web production URLs must use HTTPS');
    return 'production bindings, origins, assets, and observability configured';
  });
  await record('Staging Worker configuration', () => {
    const api = text('apps/api/wrangler.toml'); const web = text('apps/web/wrangler.toml');
    if (!api.includes('[env.staging]') || !web.includes('[env.staging]')) throw new Error('Both Workers require staging environments');
    if (!api.includes('echo-grid-feedback-api-staging') || !web.includes('echo-grid-feedback-web-staging')) throw new Error('Staging Worker names are missing');
    return 'isolated API and web staging environments configured';
  });
}

const releaseFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/wrangler.toml', 'apps/web/wrangler.toml', '.github/workflows/ci-cd.yml'];
async function manifest() {
  await record('SHA-256 release manifest', () => {
    const files = Object.fromEntries(releaseFiles.map((file) => [file, createHash('sha256').update(text(file)).digest('hex')]));
    const data = { schemaVersion: 1, block: '2F', commit: process.env.GITHUB_SHA ?? null, generatedAt: new Date().toISOString(), algorithm: 'sha256', files };
    mkdirSync(artifactDir, { recursive: true }); writeFileSync(manifestPath, `${JSON.stringify(data, null, 2)}\n`);
    return `${releaseFiles.length} release inputs hashed`;
  });
}

async function smoke() {
  const { api, web } = requireTargets();
  await record('Production API smoke', async () => {
    const { response, durationMs } = await fetchTimed(new URL('/health', api));
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'ok') throw new Error(`API health failed with ${response.status}`);
    return { status: response.status, durationMs };
  });
  await record('Production web smoke', async () => {
    const { response, durationMs } = await fetchTimed(web);
    const body = await response.text();
    if (!response.ok || body.length < 100) throw new Error(`Web smoke failed with ${response.status}`);
    return { status: response.status, durationMs, bytes: body.length };
  });
  await record('Web-to-API configuration is deployed', async () => {
    const { response } = await fetchTimed(new URL('/login', web));
    if (!response.ok) throw new Error(`Login route failed with ${response.status}`);
    return `login route returned ${response.status}`;
  });
}

async function verify() { await envAudit(); await manifest(); await smoke(); }
async function evidence() {
  await record('Complete Block 16 evidence', () => {
    for (const name of ['env-audit', 'manifest', 'smoke']) {
      const path = resolve(artifactDir, `${name}.json`);
      if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).status !== 'passed') throw new Error(`${name}.json is missing or failed`);
    }
    const manifestData = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Object.keys(manifestData.files ?? {}).length !== releaseFiles.length) throw new Error('Release manifest is incomplete');
    return 'environment audit, manifest, and production smoke passed';
  });
}

function writeEvidence(status, error) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify({ schemaVersion: 1, block: '2F', command, status, startedAt, completedAt: new Date().toISOString(), nodeVersion: process.version, targets: { api: apiUrl ?? null, web: webUrl ?? null }, ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}), steps, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }, null, 2)}\n`);
  process.stdout.write(`\n[block16] Evidence: ${artifactPath}\n`);
}

try {
  if (!allowed.has(command)) throw new Error(`Unknown Block 16 command: ${command}`);
  await ({ preflight, 'env-audit': envAudit, manifest, smoke, verify, evidence })[command]();
  writeEvidence('passed');
} catch (error) {
  writeEvidence('failed', error); process.stderr.write(`\n[block16] ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
}

