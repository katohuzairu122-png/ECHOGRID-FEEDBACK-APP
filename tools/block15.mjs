import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..');
const command = process.argv[2] ?? 'verify';
const allowed = new Set(['preflight', 'security', 'runtime', 'load', 'verify', 'evidence']);
const artifactDir = resolve(root, '.artifacts/block15');
const artifactPath = resolve(artifactDir, `${command}.json`);
const startedAt = new Date().toISOString();
const steps = [];
const apiUrl = process.env.BLOCK15_API_URL?.trim();
const webUrl = process.env.BLOCK15_WEB_URL?.trim();

function pnpm() { return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'; }
function record(name, fn) {
  const started = Date.now();
  return Promise.resolve().then(fn).then((detail) => {
    steps.push({ name, status: 'passed', durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(`\n[block15] PASS ${name}${detail ? ` — ${detail}` : ''}\n`);
    return detail;
  }).catch((error) => {
    steps.push({ name, status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
}
function run(name, program, args) {
  return record(name, () => {
    const windowsCommand = process.platform === 'win32' && program.endsWith('.cmd');
    const result = spawnSync(windowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : program, windowsCommand ? ['/d', '/s', '/c', [program, ...args].join(' ')] : args, { cwd: root, env: process.env, encoding: 'utf8', stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`${name} failed with exit code ${result.status}`);
    return [program, ...args].join(' ');
  });
}
function requireTargets() {
  if (!apiUrl || !webUrl) throw new Error('BLOCK15_API_URL and BLOCK15_WEB_URL are required');
  const api = new URL(apiUrl); const web = new URL(webUrl);
  if (api.protocol !== 'https:' || web.protocol !== 'https:') throw new Error('Block 15 runtime targets must use HTTPS');
  return { api, web };
}
async function preflight() {
  await run('pnpm available', pnpm(), ['--version']);
  await record('Required hardening files', () => {
    for (const file of ['pnpm-lock.yaml', 'apps/api/src/index.ts', 'apps/api/wrangler.toml', 'apps/web/next.config.ts', 'apps/web/wrangler.toml']) readFileSync(resolve(root, file));
    return '5 files present';
  });
}
function walk(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    if (['.git', 'node_modules', '.next', '.open-next', 'dist', '.artifacts', '.wrangler', '.pnpm-store', '.playwright-browsers', '.claude-scratch', '.localappdata'].includes(entry)) continue;
    const path = join(dir, entry); const stat = statSync(path);
    if (stat.isDirectory()) walk(path, output); else if (['.ts', '.tsx', '.js', '.mjs', '.json', '.toml', '.yml', '.yaml'].includes(extname(entry))) output.push(path);
  }
  return output;
}
async function security() {
  await preflight();
  await record('No committed credential material', () => {
    const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /sk_live_[A-Za-z0-9]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /AKIA[0-9A-Z]{16}/];
    const findings = [];
    for (const file of walk(root)) { const text = readFileSync(file, 'utf8'); if (patterns.some((pattern) => pattern.test(text))) findings.push(file.slice(root.length + 1)); }
    if (findings.length) throw new Error(`Potential credential material: ${findings.join(', ')}`);
    return `${walk(root).length} source/config files scanned`;
  });
  await record('No dangerous dynamic code', () => {
    const findings = [];
    for (const file of walk(root).filter((path) => /[.](?:ts|tsx|js|mjs)$/.test(path) && !/[.](?:test|spec)[.](?:ts|tsx|js|mjs)$/.test(path))) {
      const text = readFileSync(file, 'utf8');
      if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) findings.push(file.slice(root.length + 1));
    }
    if (findings.length) throw new Error(`Dynamic code execution found: ${findings.join(', ')}`);
    return 'eval and Function constructor absent';
  });
  await record('Production transport and CORS policy', () => {
    const apiConfig = readFileSync(resolve(root, 'apps/api/wrangler.toml'), 'utf8');
    if (/ALLOWED_ORIGINS\s*=\s*['"]\*['"]/.test(apiConfig)) throw new Error('CORS wildcard configured');
    const urls = [...apiConfig.matchAll(/https?:\/\/[^\s,'"]+/g)].map((match) => match[0]);
    const insecure = urls.filter((url) => url.startsWith('http://') && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1'));
    if (insecure.length) throw new Error(`Insecure production URLs: ${insecure.join(', ')}`);
    return 'CORS fails closed; production URLs use TLS';
  });
  await run('Production dependency audit', pnpm(), ['audit', '--prod', '--audit-level', 'high']);
}
const requiredHeaders = ['content-security-policy', 'referrer-policy', 'permissions-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options'];
async function fetchTimed(url, init) { const started = performance.now(); const response = await globalThis.fetch(url, { ...init, signal: globalThis.AbortSignal.timeout(10000) }); return { response, durationMs: performance.now() - started }; }
async function runtime() {
  const { api, web } = requireTargets();
  await record('API health and security headers', async () => {
    const { response } = await fetchTimed(new URL('/health', api));
    if (!response.ok) throw new Error(`API health returned ${response.status}`);
    const body = await response.json(); if (body.status !== 'ok') throw new Error('API health payload is not ok');
    const missing = ['strict-transport-security', 'x-content-type-options', 'x-frame-options'].filter((name) => !response.headers.has(name));
    if (missing.length) throw new Error(`API missing headers: ${missing.join(', ')}`);
    return `${response.status}; security baseline present`;
  });
  await record('CORS rejects an untrusted origin', async () => {
    const { response } = await fetchTimed(new URL('/api/v1/auth/me', api), { headers: { Origin: 'https://untrusted.invalid' } });
    if (response.headers.has('access-control-allow-origin')) throw new Error('Untrusted origin received Access-Control-Allow-Origin');
    return `status ${response.status}; no allow-origin header`;
  });
  await record('Web security headers', async () => {
    const { response } = await fetchTimed(web); if (!response.ok) throw new Error(`Web returned ${response.status}`);
    const missing = requiredHeaders.filter((name) => !response.headers.has(name));
    if (missing.length) throw new Error(`Web missing headers: ${missing.join(', ')}`);
    if (response.headers.get('x-frame-options') !== 'DENY') throw new Error('Web framing policy is not DENY');
    return `${response.status}; ${requiredHeaders.length} headers present`;
  });
}
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
async function load() {
  const { api } = requireTargets();
  const requests = Number(process.env.BLOCK15_LOAD_REQUESTS ?? 30); const concurrency = Number(process.env.BLOCK15_LOAD_CONCURRENCY ?? 5);
  const maxP95 = Number(process.env.BLOCK15_MAX_P95_MS ?? 1500); const maxErrorRate = Number(process.env.BLOCK15_MAX_ERROR_RATE ?? 0.02);
  if (!Number.isInteger(requests) || requests < 1 || requests > 500 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 25) throw new Error('Invalid load configuration');
  await record('Bounded API load smoke', async () => {
    const durations = []; let failures = 0; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
      while (cursor < requests) { cursor += 1; try { const { response, durationMs } = await fetchTimed(new URL('/health', api)); durations.push(durationMs); if (!response.ok) failures += 1; await response.arrayBuffer(); } catch { failures += 1; } }
    }));
    const errorRate = failures / requests; const p95Ms = Math.round(percentile(durations.length ? durations : [Infinity], 0.95));
    if (errorRate > maxErrorRate) throw new Error(`Error rate ${errorRate} exceeds ${maxErrorRate}`);
    if (p95Ms > maxP95) throw new Error(`p95 ${p95Ms}ms exceeds ${maxP95}ms`);
    return { requests, concurrency, failures, errorRate, p95Ms, maxP95Ms: maxP95 };
  });
}
async function verify() { await security(); await runtime(); await load(); }
async function evidence() {
  await record('Successful Block 15 evidence exists', () => {
    for (const name of ['security', 'runtime', 'load']) { const path = resolve(artifactDir, `${name}.json`); if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).status !== 'passed') throw new Error(`${name}.json is missing or failed`); }
    return 'security, runtime, and load evidence passed';
  });
}
function writeEvidence(status, error) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify({ schemaVersion: 1, block: '2E', command, status, startedAt, completedAt: new Date().toISOString(), nodeVersion: process.version, platform: `${process.platform}-${process.arch}`, targets: { api: apiUrl ?? null, web: webUrl ?? null }, ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}), steps, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }, null, 2)}\n`);
  process.stdout.write(`\n[block15] Evidence: ${artifactPath}\n`);
}
try {
  if (!allowed.has(command)) throw new Error(`Unknown Block 15 command: ${command}`);
  await ({ preflight, security, runtime, load, verify, evidence })[command](); writeEvidence('passed');
} catch (error) { writeEvidence('failed', error); process.stderr.write(`\n[block15] ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }

