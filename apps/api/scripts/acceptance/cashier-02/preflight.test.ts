import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTargetsConfig, type TargetsConfig } from './guard';
import { MAILBOX_ADAPTERS } from './adapters';
import { SPOOL_ENV } from './adapters/local-spool';
import { runPreflight, type PreflightDeps } from './preflight';

const shippedJson = JSON.parse(readFileSync(path.join(__dirname, 'staging-targets.json'), 'utf8')) as Record<string, unknown>;
const shipped = parseTargetsConfig(shippedJson);
const apiToml = readFileSync(path.join(__dirname, '../../../wrangler.toml'), 'utf8');
const webToml = readFileSync(path.join(__dirname, '../../../../web/wrangler.toml'), 'utf8');
const fullyApproved = (): TargetsConfig => parseTargetsConfig({
  ...shippedJson, approved: true, approvedBy: 'owner', approvedAt: '2026-11-20',
  mailbox: { approved: true, approvedBy: 'owner', adapter: 'local-spool', allowedRecipientDomains: ['mail.example.test'] },
  customerProvisioning: { approved: true, approvedBy: 'owner' },
  liveExecution: { authorized: true, authorizedBy: 'owner', reference: 'directive' },
});
const ownerEnv = Object.fromEntries(['EMAIL', 'PASSWORD', 'BUSINESS_ID'].flatMap((n) => ['A', 'B'].map((w) => [`ACCEPTANCE_OWNER_${w}_${n}`, `value-${w}-${n}`])));

async function deps(over: Partial<PreflightDeps> = {}, env: Record<string, string | undefined> = {}) {
  const requests: string[] = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pf-'));
  const base: PreflightDeps = {
    env: { ...ownerEnv, [SPOOL_ENV]: dir, ...env },
    fetch: async (url) => {
      requests.push(url);
      return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok', service: 'echo-grid-feedback-api', environment: 'staging' } : {}), { status: 200 });
    },
    readRepoFile: (name) => (name === 'api-wrangler' ? apiToml : webToml),
    adapters: MAILBOX_ADAPTERS,
    browser: async () => ({ ok: true, detail: 'ok' }),
    driverPresent: () => true,
  };
  return { deps: { ...base, ...over }, requests };
}
const status = (r: Awaited<ReturnType<typeof runPreflight>>, id: string) => r.items.find((i) => i.id === id)?.status;

describe('preflight: the shipped state', () => {
  it('is fully offline, reports exactly what is missing and is NOT READY (exit 2)', async () => {
    const { deps: d, requests } = await deps({}, {});
    const r = await runPreflight(shipped, d, { online: true });
    expect(requests).toEqual([]);
    expect(r.verdict).toBe('NOT READY');
    expect(r.exitCode).toBe(2);
    expect(Object.fromEntries(r.items.map((i) => [i.id, i.status]))).toMatchObject({
      P01: 'BLOCKED', P02: 'PASS', P03: 'PASS', P04: 'BLOCKED', P05: 'BLOCKED', P06: 'NOT VERIFIED', P07: 'NOT VERIFIED', P08: 'BLOCKED', P09: 'BLOCKED', P10: 'PASS', P12: 'PASS', P13: 'NOT VERIFIED', P14: 'NOT VERIFIED', P15: 'NOT VERIFIED',
    });
    expect(r.items.find((i) => i.id === 'P01')?.detail).toContain('echo-grid-feedback-cashier-staging');
  });
  it('names missing credentials only by name and never prints a value', async () => {
    const { deps: d } = await deps({}, { ACCEPTANCE_OWNER_A_PASSWORD: undefined });
    const r = await runPreflight(shipped, { ...d, env: { ACCEPTANCE_OWNER_B_PASSWORD: 'super-secret-value' } }, { online: false });
    const p10 = r.items.find((i) => i.id === 'P10')!;
    expect(p10.status).toBe('BLOCKED');
    expect(p10.detail).toContain('ACCEPTANCE_OWNER_A_EMAIL');
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
  });
});

describe('preflight: fully approved', () => {
  it('is READY when every prerequisite passes; the unverifiable secret presence is advisory and does not block', async () => {
    const { deps: d, requests } = await deps();
    const r = await runPreflight(fullyApproved(), d, { online: true });
    expect(r.items.filter((i) => i.required).map((i) => i.status)).toEqual(Array(14).fill('PASS'));
    expect(status(r, 'P15')).toBe('NOT VERIFIED');
    expect(r.verdict).toBe('READY');
    expect(r.exitCode).toBe(0);
    for (const url of requests) expect(new URL(url).hostname).toMatch(/^echo-grid-feedback-(api|web|cashier)-staging\./);
    expect(requests.length).toBeGreaterThanOrEqual(4);
  });
  it('makes no request when --online is not given, and is then NOT READY with nothing blocked (exit 4)', async () => {
    const { deps: d, requests } = await deps();
    const r = await runPreflight(fullyApproved(), d, { online: false });
    expect(requests).toEqual([]);
    expect(status(r, 'P13')).toBe('NOT VERIFIED');
    expect(r.exitCode).toBe(4);
  });
  it('makes no request while live execution is not authorized, even with hostnames approved and --online', async () => {
    const c = parseTargetsConfig({ ...(fullyApproved() as unknown as Record<string, unknown>), liveExecution: { authorized: false, authorizedBy: null, reference: null } });
    const { deps: d, requests } = await deps();
    const r = await runPreflight(c, d, { online: true });
    expect(requests).toEqual([]);
    expect(status(r, 'P04')).toBe('BLOCKED');
    expect(r.items.find((i) => i.id === 'P13')?.detail).toMatch(/live execution is not authorized/);
  });
  it('is BLOCKED when the API says it is not staging, and when a Worker does not answer', async () => {
    const prod = await deps({ fetch: async (url) => new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok', service: 'echo-grid-feedback-api', environment: 'production' } : {}), { status: 200 }) });
    expect(status(await runPreflight(fullyApproved(), prod.deps, { online: true }), 'P14')).toBe('BLOCKED');
    const down = await deps({ fetch: async (url) => (url.includes('-web-staging') ? new Response('', { status: 502 }) : new Response(JSON.stringify({ status: 'ok', service: 'echo-grid-feedback-api', environment: 'staging' }), { status: 200 })) });
    const r = await runPreflight(fullyApproved(), down.deps, { online: true });
    expect(status(r, 'P13')).toBe('BLOCKED');
    expect(r.items.find((i) => i.id === 'P13')?.detail).toBe('not reachable: web');
    expect(r.exitCode).toBe(2);
  });
});

describe('preflight: mailbox, hosts and tooling', () => {
  it('an approved mailbox whose adapter is not in this build is BLOCKED and lists what is available', async () => {
    const c = parseTargetsConfig({ ...(fullyApproved() as unknown as Record<string, unknown>), mailbox: { approved: true, approvedBy: 'owner', adapter: 'some-provider', allowedRecipientDomains: ['mail.example.test'] } });
    const r = await runPreflight(c, (await deps()).deps, { online: false });
    expect(status(r, 'P06')).toBe('BLOCKED');
    expect(r.items.find((i) => i.id === 'P06')?.detail).toContain('local-spool');
    expect(status(r, 'P07')).toBe('NOT VERIFIED');
  });
  it('an approved adapter without its configuration is BLOCKED by variable name', async () => {
    const { deps: d } = await deps();
    const r = await runPreflight(fullyApproved(), { ...d, env: { ...ownerEnv } }, { online: false });
    expect(status(r, 'P07')).toBe('BLOCKED');
    expect(r.items.find((i) => i.id === 'P07')?.detail).toContain(SPOOL_ENV);
  });
  it('hostnames that are not in the repository Worker configuration are BLOCKED; unreadable files are NOT VERIFIED', async () => {
    const { deps: d } = await deps();
    expect(status(await runPreflight(fullyApproved(), { ...d, readRepoFile: () => 'name = "other"' }, { online: false }), 'P03')).toBe('BLOCKED');
    expect(status(await runPreflight(fullyApproved(), { ...d, readRepoFile: () => null }, { online: false }), 'P03')).toBe('NOT VERIFIED');
  });
  it('missing browser automation and a missing sign-up driver are BLOCKED', async () => {
    const { deps: d } = await deps({ browser: async () => ({ ok: false, detail: 'no Chromium executable found' }), driverPresent: () => false });
    const r = await runPreflight(fullyApproved(), d, { online: false });
    expect(status(r, 'P11')).toBe('BLOCKED');
    expect(status(r, 'P12')).toBe('BLOCKED');
  });
  it('an approved domain is required for the synthetic identities', async () => {
    const c = parseTargetsConfig({ ...(fullyApproved() as unknown as Record<string, unknown>), mailbox: { approved: true, approvedBy: 'owner', adapter: 'local-spool', allowedRecipientDomains: ['mail.example.test'] } });
    expect(status(await runPreflight(c, (await deps()).deps, { online: false }), 'P08')).toBe('PASS');
    expect(status(await runPreflight(shipped, (await deps()).deps, { online: false }), 'P08')).toBe('BLOCKED');
  });
});
