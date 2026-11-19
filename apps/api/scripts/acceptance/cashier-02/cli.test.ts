import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli';

const shipped = JSON.parse(readFileSync(path.join(__dirname, 'staging-targets.json'), 'utf8')) as Record<string, unknown>;
const io = (config: unknown = shipped, fetchFn?: CliIo['fetch']) => {
  const lines: string[] = [];
  const requests: string[] = [];
  const impl: CliIo = {
    log: (l) => lines.push(l),
    fetch: fetchFn ?? (async (url) => { requests.push(url); return new Response('{}', { status: 500 }); }),
    readConfig: () => config,
    commit: () => 'deadbeef',
  };
  return { impl, lines, requests };
};
const liveOk = { liveExecution: { authorized: true, authorizedBy: 'owner', reference: 'test directive' } };
const creds = { ACCEPTANCE_OWNER_A_EMAIL: 'a@example.test', ACCEPTANCE_OWNER_A_PASSWORD: 'pw', ACCEPTANCE_OWNER_A_BUSINESS_ID: 'a', ACCEPTANCE_OWNER_B_EMAIL: 'b@example.test', ACCEPTANCE_OWNER_B_PASSWORD: 'pw', ACCEPTANCE_OWNER_B_BUSINESS_ID: 'b' };

describe('command line entry point', () => {
  it('by default only runs the offline self-check: no request, exit 0, states that live execution is disabled', async () => {
    const t = io();
    expect(await runCli([], {}, t.impl)).toBe(0);
    expect(t.requests).toEqual([]);
    expect(t.lines.join('\n')).toMatch(/approved by the owner: NO/);
    expect(t.lines.join('\n')).toMatch(/mailbox approved: NO/);
  });
  it('a live run is blocked (exit 2) with no request while the hostnames are not approved', async () => {
    const t = io();
    expect(await runCli(['--env', 'staging'], creds, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
    expect(t.lines.join('\n')).toMatch(/LIVE_NOT_APPROVED/);
  });
  it.each([['--api-url=https://x.dev'], ['--host', 'x'], ['https://example.com']])('rejects the host override %s before reading anything', async (...args) => {
    const t = io();
    expect(await runCli(['--env', 'staging', ...args], creds, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
    expect(t.lines.join('\n')).toMatch(/OVERRIDE_REJECTED/);
  });
  it('rejects a host override environment variable', async () => {
    const t = io();
    expect(await runCli(['--env', 'staging'], { ...creds, API_URL: 'https://x.dev' }, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
  });
  it('rejects any environment other than staging', async () => {
    const t = io();
    expect(await runCli(['--env', 'production'], creds, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
  });
  it('blocks on missing credentials (names only) once approved, before any request', async () => {
    const t = io({ ...shipped, ...liveOk, approved: true, approvedBy: 'owner', approvedAt: 'now' });
    expect(await runCli(['--env', 'staging'], {}, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
    expect(t.lines.join('\n')).toMatch(/ACCEPTANCE_OWNER_A_EMAIL/);
    expect(t.lines.join('\n')).not.toMatch(/@example/);
  });
  it('blocks when the API does not identify itself as staging; the only request is the health probe', async () => {
    const t = io({ ...shipped, ...liveOk, approved: true, approvedBy: 'owner', approvedAt: 'now' }, undefined);
    const seen: string[] = [];
    t.impl.fetch = async (url) => { seen.push(url); return new Response(JSON.stringify({ status: 'ok', service: 'echo-grid-feedback-api', environment: 'production' })); };
    expect(await runCli(['--env', 'staging'], creds, t.impl)).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\/health$/);
    expect(t.lines.join('\n')).toMatch(/STAGING_IDENTITY/);
  });
  it('a broken configuration is a blocked run, not a crash', async () => {
    expect(await runCli([], {}, io({ version: 1 }).impl)).toBe(2);
    expect(await runCli([], {}, io({ ...shipped, targets: { api: { host: 'echo-grid-feedback-api.katohuzairu122.workers.dev' }, web: { host: 'a-staging.x.dev' }, cashier: { host: 'b-staging.x.dev' } } }).impl)).toBe(2);
  });
});

describe('E2 wiring: approvals, provisioner, mailbox and browser evidence', () => {
  const all = { ...shipped, ...liveOk, approved: true, approvedBy: 'owner', approvedAt: 'now',
    mailbox: { approved: true, approvedBy: 'owner', adapter: 'fixture', allowedRecipientDomains: ['mail.example.test'] },
    customerProvisioning: { approved: true, approvedBy: 'owner' } };
  const stagingHealth = async (url: string) => new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok', service: 'echo-grid-feedback-api', environment: 'staging' } : { data: {} }), { status: 200 });
  const live = (config: unknown, extra: Partial<CliIo> = {}) => { const t = io(config); t.impl.fetch = stagingHealth; Object.assign(t.impl, extra); return t; };

  it('the self-check names the missing approvals', async () => {
    const t = io();
    await runCli([], {}, t.impl);
    expect(t.lines.join('\n')).toMatch(/customer provisioning approved: NO/);
    expect(t.lines.join('\n')).toMatch(/missing approvals: staging hostnames, test mailbox, customer provisioning/);
  });
  it('an approved mailbox with no adapter in this build is a blocked run (CONFIG_INVALID), not a crash', async () => {
    const t = live(all);
    expect(await runCli(['--env', 'staging'], creds, t.impl)).toBe(2);
    expect(t.lines.join('\n')).toMatch(/CONFIG_INVALID.*adapter/);
  });
  it('all approvals but no sign-up driver is blocked (PROVISIONER_REFUSED)', async () => {
    const t = live(all, { mailboxAdapters: { fixture: () => ({ listMessages: async () => [] }) } });
    expect(await runCli(['--env', 'staging'], creds, t.impl)).toBe(2);
    expect(t.lines.join('\n')).toMatch(/PROVISIONER_REFUSED/);
  });
  it('partial approvals never build a provisioner: the driver is not even asked for', async () => {
    let asked = false;
    const t = live({ ...all, customerProvisioning: { approved: false, approvedBy: null } }, { signupDriver: async () => { asked = true; return {} as never; }, mailboxAdapters: { fixture: () => ({ listMessages: async () => [] }) } });
    await runCli(['--env', 'staging'], creds, t.impl);
    expect(asked).toBe(false);
  });
  it('a live run is refused while live execution is not authorized, even with the hostnames approved', async () => {
    const t = live({ ...shipped, approved: true, approvedBy: 'owner', approvedAt: 'now' });
    expect(await runCli(['--env', 'staging'], creds, t.impl)).toBe(2);
    expect(t.lines.join('\n')).toMatch(/Live execution is not authorized/);
  });
});

describe('E2C: live-execution gates cannot be bypassed', () => {
  const approvedHostsOnly = { ...shipped, approved: true, approvedBy: 'owner', approvedAt: 'now' };
  it.each([
    ['environment switches', { ACCEPTANCE_LIVE_EXECUTION: '1', ACCEPTANCE_APPROVED: 'true', STAGING_APPROVED: '1', FORCE: '1', CI: 'true' }],
    ['environment authorization claims', { ACCEPTANCE_LIVE_EXECUTION_AUTHORIZED: 'true', ACCEPTANCE_AUTHORIZED_BY: 'me' }],
  ])('%s do not authorize a live run', async (_n, extra) => {
    const t = io(approvedHostsOnly);
    t.impl.fetch = async (u) => { t.requests.push(u); return new Response('{}'); };
    expect(await runCli(['--env', 'staging'], { ...creds, ...extra }, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
    expect(t.lines.join('\n')).toMatch(/Live execution is not authorized/);
  });
  it.each([['--force'], ['--approve'], ['--live'], ['--authorized=true'], ['--skip-preflight'], ['--no-guard']])('the flag %s changes nothing', async (flag) => {
    const t = io(approvedHostsOnly);
    t.impl.fetch = async (u) => { t.requests.push(u); return new Response('{}'); };
    expect(await runCli(['--env', 'staging', flag], creds, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
  });
  it('an approved mailbox without the other approvals, or a domain without the mailbox, does not enable customer provisioning', async () => {
    const mailboxOnly = { ...approvedHostsOnly, liveExecution: { authorized: true, authorizedBy: 'owner', reference: 'x' }, mailbox: { approved: true, approvedBy: 'owner', adapter: 'local-spool', allowedRecipientDomains: ['mail.example.test'] } };
    let asked = false;
    const t = io(mailboxOnly);
    t.impl.fetch = async (u) => new Response(JSON.stringify(u.endsWith('/health') ? { status: 'ok', service: 'echo-grid-feedback-api', environment: 'staging' } : { data: {} }));
    t.impl.signupDriver = async () => { asked = true; return {} as never; };
    await runCli(['--env', 'staging'], creds, t.impl);
    expect(asked).toBe(false);
  });
  it('a production host in the configuration is refused before any request even when everything else is approved', async () => {
    const prod = { ...approvedHostsOnly, targets: { ...(shipped.targets as object), api: { host: 'echo-grid-feedback-api.katohuzairu122.workers.dev' } }, liveExecution: { authorized: true, authorizedBy: 'o', reference: 'r' } };
    const t = io(prod);
    t.impl.fetch = async (u) => { t.requests.push(u); return new Response('{}'); };
    expect(await runCli(['--env', 'staging'], creds, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
  });
});

describe('E2: the preflight command', () => {
  const pf = { readRepoFile: () => null, browser: async () => ({ ok: false, detail: 'no browser' }), driverPresent: () => false };
  it('reports every prerequisite and the verdict, makes no request, and exits 2 while anything is BLOCKED', async () => {
    const t = io();
    t.impl.preflight = pf;
    expect(await runCli(['--preflight', '--online'], {}, t.impl)).toBe(2);
    expect(t.requests).toEqual([]);
    const text = t.lines.join('\n');
    expect(text).toMatch(/BLOCKED\s+P01/);
    expect(text).toMatch(/verdict: NOT READY/);
  });
  it('still rejects host overrides', async () => {
    const t = io();
    t.impl.preflight = pf;
    expect(await runCli(['--preflight', '--api-url=https://x.dev'], {}, t.impl)).toBe(2);
    expect(t.lines.join('\n')).toMatch(/OVERRIDE_REJECTED/);
  });
  it('is unavailable (blocked) where its dependencies are not provided', async () => {
    expect(await runCli(['--preflight'], {}, io().impl)).toBe(2);
  });
});
