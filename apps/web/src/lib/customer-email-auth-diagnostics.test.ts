import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/customer-email-auth-client', () => ({
  callCustomerAuthApi: h.api,
  isCustomerEmailAuthWebEnabled: () => process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true',
}));
vi.mock('@/lib/customer-session', () => ({ setRotatingCustomerSession: vi.fn(async () => {}) }));
vi.mock('@/lib/customer-session-refresh', () => ({ revokeRotatingCustomerSession: vi.fn(async () => {}) }));

import { logEmailAuthWebUnavailable } from './customer-email-auth-diagnostics';
import { loginWithEmailAction, requestEmailRegistrationAction } from './actions/customer-email-auth';

const SENTINELS = ['victim@example.test', 'hunter2-password-sentinel', 'secret-detail-should-not-leak'];
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const lines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
const clean = (l: Array<Record<string, unknown>>) => { for (const s of SENTINELS) expect(JSON.stringify(l)).not.toContain(s); };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'true';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('web reason codes for the generic "not available" screen', () => {
  it('flag off at action time: logged as web_flag_disabled, answer unchanged, API never called', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = '';
    expect(await requestEmailRegistrationAction({}, form({ email: 'victim@example.test' }))).toEqual({ error: 'unavailable' });
    expect(h.api).not.toHaveBeenCalled();
    expect(lines(warn)).toEqual([{ event: 'customer_email_auth_web_unavailable', reason: 'web_flag_disabled', action: 'register_request' }]);
    clean(lines(warn));
  });

  it('the call throwing: logged as api_fetch_failed with the error CLASS only', async () => {
    h.api.mockRejectedValue(new Error('secret-detail-should-not-leak victim@example.test'));
    expect(await requestEmailRegistrationAction({}, form({ email: 'victim@example.test' }))).toEqual({ error: 'unavailable' });
    expect(lines(warn)).toEqual([{ event: 'customer_email_auth_web_unavailable', reason: 'api_fetch_failed', action: 'register_request', errorName: 'Error' }]);
    clean(lines(warn));
  });

  it('an unmapped API status (503) is logged with the status number; the screen answer is unchanged', async () => {
    h.api.mockResolvedValue({ status: 503, body: { error: 'Service unavailable' } });
    expect(await requestEmailRegistrationAction({}, form({ email: 'victim@example.test' }))).toEqual({ error: 'unavailable' });
    expect(lines(warn)).toEqual([{ event: 'customer_email_auth_web_unavailable', reason: 'api_unexpected_status', action: 'register_request', status: 503 }]);
    clean(lines(warn));
  });

  it('sign-in: 503 is logged against the login action; a normal 401 and a 429 are NOT logged', async () => {
    h.api.mockResolvedValue({ status: 503, body: null });
    expect(await loginWithEmailAction({}, form({ email: 'victim@example.test', password: 'hunter2-password-sentinel' }))).toEqual({ error: 'unavailable' });
    expect(lines(warn)).toEqual([{ event: 'customer_email_auth_web_unavailable', reason: 'api_unexpected_status', action: 'login', status: 503 }]);
    clean(lines(warn));
    warn.mockClear();
    h.api.mockResolvedValue({ status: 401, body: null });
    expect(await loginWithEmailAction({}, form({ email: 'victim@example.test', password: 'x' }))).toEqual({ error: 'invalid_credentials' });
    h.api.mockResolvedValue({ status: 429, body: null });
    expect(await loginWithEmailAction({}, form({ email: 'victim@example.test', password: 'x' }))).toEqual({ error: 'rate_limited' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a 200 whose credentials cannot be read is logged as api_response_unreadable', async () => {
    h.api.mockResolvedValue({ status: 200, body: { nope: true } });
    expect(await loginWithEmailAction({}, form({ email: 'victim@example.test', password: 'x' }))).toEqual({ error: 'unavailable' });
    expect(lines(warn)).toEqual([{ event: 'customer_email_auth_web_unavailable', reason: 'api_response_unreadable', action: 'login' }]);
  });

  it('a successful request logs nothing', async () => {
    h.api.mockResolvedValue({ status: 202, body: { accepted: true } });
    expect(await requestEmailRegistrationAction({}, form({ email: 'victim@example.test' }))).toEqual({ sent: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('the helper accepts only integer HTTP statuses and a throwing console.warn is swallowed', () => {
    logEmailAuthWebUnavailable('api_unexpected_status', { action: 'login', status: 9999 });
    logEmailAuthWebUnavailable('api_unexpected_status', { action: 'login', status: 1.5 });
    expect(lines(warn).every((l) => !('status' in l))).toBe(true);
    warn.mockImplementation(() => { throw new Error('console down'); });
    expect(() => logEmailAuthWebUnavailable('api_fetch_failed', { action: 'login', error: 'x' })).not.toThrow();
  });
});
