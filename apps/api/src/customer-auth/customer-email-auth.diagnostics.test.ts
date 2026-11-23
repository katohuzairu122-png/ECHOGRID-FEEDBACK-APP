import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEmailAuthUnavailable, logRegistrationDelivery } from './customer-email-auth.diagnostics';
import { limitEmailAuthRequest, createIsolatedCustomerEmailAuthRoutes } from './customer-email-auth.routes';

const SENTINELS = ['victim@example.test', '203.0.113.9', 'sekrit-value-0123456789abcdef0123456789', 'binding-detail-should-not-leak'];

function captured(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}
function expectNoSensitive(lines: Array<Record<string, unknown>>) {
  const text = JSON.stringify(lines);
  for (const s of SENTINELS) expect(text).not.toContain(s);
}

const baseDeps = {
  keyForIdentifier: async () => 'identifier-digest',
  limit: async () => true,
  resolveTrustedSource: async () => 'source-digest' as string | null,
};
const request = new Request('https://api.test/api/v1/customer-auth/email/register/request', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.9' } });

afterEach(() => vi.restoreAllMocks());

describe('privacy-safe registration delivery milestones (PROD-AUTH-05)', () => {
  it('logs only fixed event codes and a bounded HTTP status', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logRegistrationDelivery('challenge_created');
    logRegistrationDelivery('delivery_attempted');
    logRegistrationDelivery('delivery_failed', { failureKind: 'provider_http', providerStatus: 403 });
    logRegistrationDelivery('delivery_failed', { failureKind: 'transport_or_internal', providerStatus: 999 });
    expect(captured(info)).toEqual([
      { event: 'customer_registration_delivery', stage: 'challenge_created' },
      { event: 'customer_registration_delivery', stage: 'delivery_attempted' },
      { event: 'customer_registration_delivery', stage: 'delivery_failed', providerStatus: 403, failureKind: 'provider_http' },
      { event: 'customer_registration_delivery', stage: 'delivery_failed', failureKind: 'transport_or_internal' },
    ]);
    expectNoSensitive(captured(info));
  });

  it('logging failure never changes registration request behavior', () => {
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('sink unavailable'); });
    expect(() => logRegistrationDelivery('provider_accepted')).not.toThrow();
  });
});

describe('reason-coded diagnostics for the generic 503', () => {
  it('an untrusted (unsigned or mismatched) source is logged as untrusted_source, and the decision is still "unavailable"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const decision = await limitEmailAuthRequest({ ...baseDeps, resolveTrustedSource: async () => null }, request, 'delivery', 'victim@example.test');
    expect(decision).toBe('unavailable');
    expect(captured(warn)).toEqual([{ event: 'customer_email_auth_unavailable', reason: 'untrusted_source', surface: 'delivery' }]);
    expectNoSensitive(captured(warn));
  });

  it('a failing rate-limit Durable Object is logged as limiter_error with the error CLASS only, never its message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class DurableObjectError extends Error {}
    const decision = await limitEmailAuthRequest(
      { ...baseDeps, limit: async () => { throw new DurableObjectError('binding-detail-should-not-leak sekrit-value-0123456789abcdef0123456789'); } },
      request, 'login', 'victim@example.test',
    );
    expect(decision).toBe('unavailable');
    expect(captured(warn)).toEqual([{ event: 'customer_email_auth_unavailable', reason: 'limiter_error', surface: 'login', errorName: 'Error' }]);
    expectNoSensitive(captured(warn));
  });

  it('an allowed request logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await limitEmailAuthRequest(baseDeps, request, 'delivery', 'victim@example.test')).toBe('allowed');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a rate-limited request is a 429 decision and is NOT logged as unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await limitEmailAuthRequest({ ...baseDeps, limit: async () => false }, request, 'delivery', 'victim@example.test')).toBe('limited');
    expect(warn).not.toHaveBeenCalled();
  });

  it('missing settings are listed by NAME only; free-text entries are reduced to a fixed label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logEmailAuthUnavailable('config_incomplete', {
      surface: 'runtime',
      missing: ['CLIENT_ATTRIBUTION_SECRET', 'CUSTOMER_SESSION_*_TTL_SECONDS', 'has a space and sekrit-value-0123456789abcdef0123456789'],
    });
    expect(captured(warn)).toEqual([{
      event: 'customer_email_auth_unavailable', reason: 'config_incomplete', surface: 'runtime',
      missing: ['CLIENT_ATTRIBUTION_SECRET', 'CUSTOMER_SESSION_*_TTL_SECONDS', 'invalid_or_incoherent_setting'],
    }]);
    expectNoSensitive(captured(warn));
  });

  it('a non-Error throw is reduced to a fixed label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logEmailAuthUnavailable('runtime_open_failed', { surface: 'runtime', error: 'binding-detail-should-not-leak' });
    expect(captured(warn)[0]).toMatchObject({ errorName: 'non_error_thrown' });
    expectNoSensitive(captured(warn));
  });

  it('logging can never change a response: a throwing console.warn is swallowed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('console down'); });
    expect(() => logEmailAuthUnavailable('limiter_error', { surface: 'login' })).not.toThrow();
  });

  it('through the mounted router: an untrusted source still answers the same generic 503 and logs exactly one line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const routes = createIsolatedCustomerEmailAuthRoutes({
      ...baseDeps,
      resolveTrustedSource: async () => null,
      requestProof: async () => { throw new Error('must not be reached'); },
      completeRegistration: async () => { throw new Error('must not be reached'); },
      login: async () => { throw new Error('must not be reached'); },
      transportSession: () => new Response(null),
    } as never);
    const res = await routes.request('/email/register/request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'victim@example.test' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service unavailable' });
    expect(captured(warn)).toEqual([{ event: 'customer_email_auth_unavailable', reason: 'untrusted_source', surface: 'delivery' }]);
    expectNoSensitive(captured(warn));
  });
});
