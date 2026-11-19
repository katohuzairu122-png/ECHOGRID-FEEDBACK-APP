import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTargets } from '../../e2e/acceptance/targets';

/**
 * CASHIER-AUTH-02E E2-C: the browser acceptance tier may run only on the local stack, or on the harness's staging hosts once the owner has
 * approved them. No override exists.
 */
const shipped = JSON.parse(readFileSync(path.join(__dirname, '../../../api/scripts/acceptance/cashier-02/staging-targets.json'), 'utf8')) as Record<string, unknown>;
const approved = { ...shipped, approved: true, approvedBy: 'owner', approvedAt: '2026-11-20' };

describe('browser acceptance targets', () => {
  it('local mode is exactly the local development stack', () => {
    expect(resolveTargets({ E2E_ACCEPTANCE_MODE: 'local' }, () => shipped)).toEqual({ mode: 'local', web: 'http://localhost:3000', cashier: 'http://localhost:3000' });
  });
  it('staging mode is refused while the owner has not approved the hostnames (the shipped state)', () => {
    expect(() => resolveTargets({ E2E_ACCEPTANCE_MODE: 'staging' }, () => shipped)).toThrowError(expect.objectContaining({ code: 'LIVE_NOT_APPROVED' }));
  });
  it('staging mode uses only the configured staging hosts once approved', () => {
    const t = resolveTargets({ E2E_ACCEPTANCE_MODE: 'staging' }, () => approved);
    expect(t.mode).toBe('staging');
    expect(t.web).toMatch(/^https:\/\/echo-grid-feedback-web-staging\./);
    expect(t.cashier).toMatch(/^https:\/\/echo-grid-feedback-cashier-staging\./);
  });
  it('a production host in the configuration is refused even when approved', () => {
    const bad = { ...approved, targets: { ...((approved as { targets?: object }).targets ?? {}), web: { host: 'echo-grid-feedback-web.katohuzairu122.workers.dev' } } };
    expect(() => resolveTargets({ E2E_ACCEPTANCE_MODE: 'staging' }, () => bad)).toThrowError(expect.objectContaining({ code: 'HOST_PRODUCTION' }));
  });
  it.each([['E2E_BASE_URL'], ['E2E_WEB_URL'], ['E2E_CASHIER_URL'], ['E2E_ALLOW_PRODUCTION']])('rejects the override %s in every mode', (key) => {
    expect(() => resolveTargets({ E2E_ACCEPTANCE_MODE: 'local', [key]: 'https://echo-grid.uk' }, () => shipped)).toThrow(/overrides/);
    expect(() => resolveTargets({ E2E_ACCEPTANCE_MODE: 'staging', [key]: '1' }, () => approved)).toThrow(/overrides/);
  });
  it('an unknown or missing mode is refused', () => {
    expect(() => resolveTargets({}, () => shipped)).toThrow(/must be/);
    expect(() => resolveTargets({ E2E_ACCEPTANCE_MODE: 'production' }, () => shipped)).toThrow(/must be/);
  });
});
