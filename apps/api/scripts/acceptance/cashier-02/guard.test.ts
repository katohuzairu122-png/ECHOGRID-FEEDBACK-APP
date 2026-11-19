import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HarnessRefusal, assertAllowedUrl, assertNoHostOverrides, guardTargets, isProductionHost, parseTargetsConfig, verifyStagingIdentity,
} from './guard';

const shipped = JSON.parse(readFileSync(path.join(__dirname, 'staging-targets.json'), 'utf8')) as unknown;
const good = () => parseTargetsConfig(shipped);
const approved = () => parseTargetsConfig({ ...(shipped as object), approved: true, approvedBy: 'owner', approvedAt: '2026-11-20' });
const refusal = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(HarnessRefusal); expect((e as HarnessRefusal).code).toBe(code); return; }
  throw new Error(`expected refusal ${code}`);
};

describe('shipped configuration', () => {
  it('is valid, disabled for live execution and has no approved mailbox', () => {
    const c = good();
    expect(c.approved).toBe(false);
    expect(c.mailbox.approved).toBe(false);
    expect(c.mailbox.adapter).toBe('none');
    expect(c.customerProvisioning.approved).toBe(false);
    expect(c.liveExecution).toEqual({ authorized: false, authorizedBy: null, reference: null });
  });
  it('lists exactly the staging hosts that the repository configuration defines (not invented)', () => {
    const api = readFileSync(path.join(__dirname, '../../../wrangler.toml'), 'utf8');
    const web = readFileSync(path.join(__dirname, '../../../../web/wrangler.toml'), 'utf8');
    const c = good();
    expect(`${api}\n${web}`).toContain(c.targets.web.host);
    expect(web).toContain(`https://${c.targets.api.host}`);
    expect(web).toContain(`CASHIER_HOST = "${c.targets.cashier.host}"`);
    expect(api).toContain('name = "echo-grid-feedback-api-staging"');
    expect(c.targets.api.host.startsWith('echo-grid-feedback-api-staging.')).toBe(true);
  });
  it('refuses a live run while the owner approval is not recorded', () => {
    refusal(() => guardTargets(good(), { requireApproval: true }), 'LIVE_NOT_APPROVED');
    expect(() => guardTargets(good(), { requireApproval: false })).not.toThrow();
    expect(() => guardTargets(approved(), { requireApproval: true })).not.toThrow();
  });
});

describe('configuration validation', () => {
  const base = shipped as { targets: Record<string, { host: string }> };
  const withHost = (key: string, host: string) => ({ ...(shipped as object), targets: { ...base.targets, [key]: { host } } });
  it.each([
    ['production api worker', 'api', 'echo-grid-feedback-api.katohuzairu122.workers.dev', 'HOST_PRODUCTION'],
    ['production web worker', 'web', 'echo-grid-feedback-web.katohuzairu122.workers.dev', 'HOST_PRODUCTION'],
    ['production cashier worker', 'cashier', 'echo-grid-feedback-cashier.katohuzairu122.workers.dev', 'HOST_PRODUCTION'],
    ['production domain', 'api', 'api.echo-grid.uk', 'HOST_PRODUCTION'],
    ['apex domain', 'web', 'echo-grid.uk', 'HOST_PRODUCTION'],
    ['name containing production', 'api', 'echo-grid-staging-production.example.dev', 'HOST_PRODUCTION'],
    ['not a staging name', 'api', 'example.com', 'CONFIG_INVALID'],
    ['uppercase', 'api', 'Echo-Grid-Feedback-Api-Staging.katohuzairu122.workers.dev', 'CONFIG_INVALID'],
    ['with a port', 'api', 'echo-grid-feedback-api-staging.katohuzairu122.workers.dev:8443', 'CONFIG_INVALID'],
    ['with a path', 'api', 'echo-grid-feedback-api-staging.katohuzairu122.workers.dev/x', 'CONFIG_INVALID'],
    ['an IP literal', 'api', '127.0.0.1', 'CONFIG_INVALID'],
    ['empty', 'api', '', 'CONFIG_INVALID'],
  ])('rejects %s', (_n, key, host, code) => refusal(() => parseTargetsConfig(withHost(key, host)), code));
  it('rejects duplicate hosts, missing sections, wrong version and malformed approvals', () => {
    refusal(() => parseTargetsConfig(withHost('web', base.targets.api!.host)), 'CONFIG_INVALID');
    refusal(() => parseTargetsConfig({ version: 1 }), 'CONFIG_INVALID');
    refusal(() => parseTargetsConfig({ ...(shipped as object), version: 2 }), 'CONFIG_INVALID');
    refusal(() => parseTargetsConfig(null), 'CONFIG_INVALID');
    refusal(() => parseTargetsConfig({ ...(shipped as object), approved: true }), 'CONFIG_INVALID');
    refusal(() => parseTargetsConfig({ ...(shipped as object), mailbox: { approved: true, approvedBy: null, adapter: 'none', allowedRecipientDomains: [] } }), 'CONFIG_INVALID');
  });
  it('validates the live-execution authorization', () => {
    refusal(() => parseTargetsConfig({ ...(shipped as object), liveExecution: { authorized: true, authorizedBy: null, reference: null } }), 'CONFIG_INVALID');
    refusal(() => parseTargetsConfig({ ...(shipped as object), liveExecution: { authorized: 'yes' } }), 'CONFIG_INVALID');
    expect(parseTargetsConfig({ ...(shipped as object), liveExecution: { authorized: true, authorizedBy: 'owner', reference: 'directive' } }).liveExecution.authorized).toBe(true);
    expect(parseTargetsConfig({ ...(shipped as object), liveExecution: undefined }).liveExecution.authorized).toBe(false);
  });
  it('classifies production hosts', () => {
    expect(isProductionHost('echo-grid-feedback-api.x.workers.dev')).toBe(true);
    expect(isProductionHost('cashier.echo-grid.uk')).toBe(true);
    expect(isProductionHost('echo-grid-feedback-api-staging.x.workers.dev')).toBe(false);
  });
});

describe('outbound URL allow-list', () => {
  const t = guardTargets(approved(), { requireApproval: true });
  const host = approved().targets.api.host;
  it('accepts only the exact staging hosts over plain https', () => {
    expect(assertAllowedUrl(t, `https://${host}/api/v1/x`).hostname).toBe(host);
  });
  it.each([
    ['http', `http://${host}/x`, 'URL_MALFORMED'],
    ['credentials', `https://u:p@${host}/x`, 'URL_MALFORMED'],
    ['port', `https://${host}:444/x`, 'URL_MALFORMED'],
    ['fragment', `https://${host}/x#a`, 'URL_MALFORMED'],
    ['garbage', 'not a url', 'URL_MALFORMED'],
    ['unknown host', 'https://example.com/x', 'HOST_NOT_ALLOWED'],
    ['lookalike suffix', `https://${host}.evil.example/x`, 'HOST_NOT_ALLOWED'],
    ['lookalike prefix', `https://evil-${host}/x`, 'HOST_NOT_ALLOWED'],
    ['production worker', 'https://echo-grid-feedback-api.katohuzairu122.workers.dev/x', 'HOST_PRODUCTION'],
    ['production domain', 'https://api.echo-grid.uk/x', 'HOST_PRODUCTION'],
  ])('refuses %s', (_n, url, code) => refusal(() => assertAllowedUrl(t, url), code));
});

describe('host overrides', () => {
  it.each([['--api-url=https://x.dev'], ['--host'], ['--base', 'x'], ['https://example.com'], ['--target=staging'], ['--env-file']])('rejects argument %s', (...args) => {
    refusal(() => assertNoHostOverrides(args, {}), 'OVERRIDE_REJECTED');
  });
  it.each([['API_URL'], ['ACCEPTANCE_API_URL'], ['CASHIER_HOST'], ['BASE_URL'], ['STAGING_ORIGIN']])('rejects environment variable %s', (key) => {
    refusal(() => assertNoHostOverrides([], { [key]: 'x' }), 'OVERRIDE_REJECTED');
  });
  it('accepts the supported arguments and the credential variables', () => {
    expect(() => assertNoHostOverrides(['--env', 'staging', '--scenarios', 'S01,S02', '--require-all'], { ACCEPTANCE_OWNER_A_EMAIL: 'x' })).not.toThrow();
  });
});

describe('staging identity', () => {
  const t = guardTargets(approved(), { requireApproval: true });
  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  it('passes only when the API reports the staging environment', async () => {
    await expect(verifyStagingIdentity(reply({ status: 'ok', service: 'echo-grid-feedback-api', environment: 'staging' }), t)).resolves.toBeUndefined();
  });
  it.each([
    ['production', { status: 'ok', service: 'echo-grid-feedback-api', environment: 'production' }],
    ['missing environment', { status: 'ok', service: 'echo-grid-feedback-api' }],
    ['other service', { status: 'ok', service: 'other', environment: 'staging' }],
    ['not ok', { status: 'down', service: 'echo-grid-feedback-api', environment: 'staging' }],
    ['not an object', 'staging'],
  ])('refuses %s', async (_n, body) => {
    await expect(verifyStagingIdentity(reply(body), t)).rejects.toMatchObject({ code: 'STAGING_IDENTITY' });
  });
  it('refuses when the health endpoint is unreachable, errors or redirects', async () => {
    await expect(verifyStagingIdentity(async () => { throw new Error('down'); }, t)).rejects.toMatchObject({ code: 'STAGING_IDENTITY' });
    await expect(verifyStagingIdentity(reply({}, 500), t)).rejects.toMatchObject({ code: 'STAGING_IDENTITY' });
    let init: RequestInit | undefined;
    await verifyStagingIdentity(async (_u, i) => { init = i; return new Response(JSON.stringify({ status: 'ok', service: 'echo-grid-feedback-api', environment: 'staging' })); }, t);
    expect(init?.redirect).toBe('error');
  });
});
