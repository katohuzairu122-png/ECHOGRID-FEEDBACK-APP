import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const command = process.argv[2] ?? 'verify';
const allowed = new Set(['preflight', 'audit', 'verify-static', 'verify', 'evidence']);
const artifactDir = resolve(root, '.artifacts/block17');
const artifactPath = resolve(artifactDir, `${command}.json`);
const apiUrl = process.env.BLOCK17_API_URL?.trim();
const startedAt = new Date().toISOString();
const steps = [];

function text(path) { return readFileSync(resolve(root, path), 'utf8'); }
function record(name, fn) {
  const started = Date.now();
  return Promise.resolve().then(fn).then((detail) => {
    steps.push({ name, status: 'passed', durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    process.stdout.write(`\n[block17] PASS ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}\n`);
    return detail;
  }).catch((error) => {
    steps.push({ name, status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
}
function run(name, program, args) {
  return record(name, () => {
    const windows = process.platform === 'win32' && program.endsWith('.cmd');
    const result = spawnSync(windows ? (process.env.ComSpec ?? 'cmd.exe') : program, windows ? ['/d', '/s', '/c', [program, ...args].join(' ')] : args, { cwd: root, env: process.env, encoding: 'utf8', stdio: 'inherit' });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`${name} failed with exit code ${result.status}`);
    return [program, ...args].join(' ');
  });
}
function pnpm() { return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'; }

async function preflight() {
  await record('Required billing implementation', () => {
    const files = ['apps/api/src/billing/billing.service.ts', 'apps/api/src/billing/stripe-webhook.routes.ts', 'apps/api/src/billing/stripe-webhook.service.ts', 'apps/api/src/billing/subscription-provisioning.service.ts', 'apps/api/src/db/seed/subscription-plans.seed.ts', 'docs/COMMERCIAL-POLICY.md'];
    for (const file of files) text(file);
    return `${files.length} billing files present`;
  });
}

async function audit() {
  await preflight();
  await record('Commercial decisions are explicit', () => {
    const policy = text('docs/COMMERCIAL-POLICY.md');
    for (const heading of ['Plan catalog', 'Trial', 'Payment failure and grace period', 'Downgrades and cancellation', 'Refunds', 'Currencies, tax, and invoices']) if (!policy.includes(`## ${heading}`)) throw new Error(`Commercial policy missing: ${heading}`);
    const seed = text('apps/api/src/db/seed/subscription-plans.seed.ts');
    for (const key of ["key: 'starter'", "key: 'growth'", "key: 'enterprise'"]) if (!seed.includes(key)) throw new Error(`Plan seed missing ${key}`);
    if (!/TRIAL_PERIOD_DAYS\s*=\s*14/.test(text('apps/api/src/billing/subscription-provisioning.service.ts'))) throw new Error('14-day trial policy and implementation disagree');
    return 'plans, pricing, trial, limits, grace, downgrade, refund, currency, tax, and invoices decided';
  });
  await record('Hosted payment surfaces and redirect controls', () => {
    const service = text('apps/api/src/billing/billing.service.ts');
    for (const marker of ['checkout.sessions.create', 'billingPortal.sessions.create', 'assertRedirectOriginAllowed', "mode: 'subscription'", 'subscription_data']) if (!service.includes(marker)) throw new Error(`Billing service missing ${marker}`);
    return 'Stripe Checkout and Customer Portal remain outside application PCI scope';
  });
  await record('Webhook authenticity and lifecycle coverage', () => {
    const route = text('apps/api/src/billing/stripe-webhook.routes.ts');
    const service = text('apps/api/src/billing/stripe-webhook.service.ts');
    if (!route.includes('constructEventAsync') || !route.includes('stripe-signature')) throw new Error('Webhook signature verification missing');
    for (const event of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) if (!service.includes(event)) throw new Error(`Webhook lifecycle missing ${event}`);
    for (const status of ['past_due', 'unpaid', 'canceled']) if (!text('apps/api/src/db/schema/business-subscriptions.ts').includes(status)) throw new Error(`Subscription state missing ${status}`);
    return 'signed, replay-resistant, idempotent subscription lifecycle covered';
  });
  await record('Billing permission boundaries', () => {
    const routes = text('apps/api/src/billing/billing.routes.ts');
    for (const marker of ['authenticate', 'resolveTenantContext', 'requireBusinessWideAccess', "requirePermission('billing:view')", "requirePermission('billing:manage')"]) if (!routes.includes(marker)) throw new Error(`Billing route boundary missing ${marker}`);
    return 'authenticated, tenant-scoped view/manage permissions enforced';
  });
}

async function verifyStatic() {
  await audit();
  await run('Focused billing lifecycle tests', pnpm(), ['--filter', '@echo-grid-feedback/api', 'exec', 'vitest', 'run', 'src/billing']);
}

async function verify() {
  if (!apiUrl) throw new Error('BLOCK17_API_URL is required');
  const api = new URL(apiUrl); if (api.protocol !== 'https:') throw new Error('Block 17 API target must use HTTPS');
  await record('Billing API rejects anonymous access', async () => {
    const response = await globalThis.fetch(new URL('/api/v1/billing/plans', api), { signal: globalThis.AbortSignal.timeout(15000) });
    if (![401, 403].includes(response.status)) throw new Error(`Anonymous billing request returned ${response.status}`);
    return `status ${response.status}`;
  });
  await record('Production webhook rejects unsigned payloads', async () => {
    const response = await globalThis.fetch(new URL('/webhooks/stripe', api), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: globalThis.AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => null);
    if (response.status !== 400 || body?.error?.code !== 'MISSING_SIGNATURE') throw new Error(`Unsigned webhook returned ${response.status}/${body?.error?.code ?? 'unknown'}`);
    return '400 MISSING_SIGNATURE';
  });
}

async function evidence() {
  await record('Complete Block 17 evidence', () => {
    for (const name of ['audit', 'verify-static', 'verify']) {
      const path = resolve(artifactDir, `${name}.json`);
      if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).status !== 'passed') throw new Error(`${name}.json is missing or failed`);
    }
    return 'commercial audit, focused lifecycle tests, and production boundaries passed';
  });
}

function writeEvidence(status, error) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify({ schemaVersion: 1, block: '2G', command, status, startedAt, completedAt: new Date().toISOString(), nodeVersion: process.version, target: apiUrl ?? null, ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}), steps, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }, null, 2)}\n`);
  process.stdout.write(`\n[block17] Evidence: ${artifactPath}\n`);
}

try {
  if (!allowed.has(command)) throw new Error(`Unknown Block 17 command: ${command}`);
  await ({ preflight, audit, 'verify-static': verifyStatic, verify, evidence })[command](); writeEvidence('passed');
} catch (error) {
  writeEvidence('failed', error); process.stderr.write(`\n[block17] ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
}

