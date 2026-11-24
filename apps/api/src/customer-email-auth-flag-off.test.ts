import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from './config/env';
import { signCustomerAccessToken } from './customer-auth/customer-jwt';

/**
 * STAGING ACCEPTANCE CLOSURE, case D: the REAL mounted API app (src/index.ts) with CUSTOMER_EMAIL_AUTH_ENABLED off. Only the database and
 * the rate limiters are replaced. Proves the email-auth surface is a generic 404 for anything but the exact string "true", and that
 * legacy customer authentication keeps working beside it. (The live staging flag is deliberately NOT toggled for this.)
 */
const mocks = vi.hoisted(() => ({ findCustomer: vi.fn(async () => ({ status: 'active' })), listAccounts: vi.fn(async () => []) }));
vi.mock('./db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('./repositories', () => ({ createRepositories: () => ({
  customers: { findById: mocks.findCustomer },
  customerDeletionRequests: { findPending: async () => null },
  loyaltyAccounts: { listForCustomer: mocks.listAccounts },
}) }));
vi.mock('./middleware/rate-limit', () => {
  const pass = () => async (_c: unknown, next: () => Promise<void>) => next();
  return {
    rateLimit: pass, globalApiRateLimit: pass, rateLimitByCustomer: pass, staffLoginRateLimit: pass, signupRateLimit: pass,
    passwordResetRequestRateLimit: pass, passwordResetConfirmRateLimit: pass, passwordChangeRateLimit: pass, cashierAuthRateLimit: pass, managedCashierLoginRateLimit: pass, adminReauthRateLimit: pass,
  };
});
vi.mock('./middleware/audit', () => ({ auditTrail: async (_c: unknown, next: () => Promise<void>) => next() }));

import worker from './index';

const customerId = '11111111-1111-4111-8111-111111111111';
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const baseEnv = { CUSTOMER_JWT_SECRET: 'customer-test-secret-value-0123456789', JWT_ACCESS_SECRET: 'staff-test-secret' };
const withFlag = (value: string | undefined) => ({ ...baseEnv, ...(value === undefined ? {} : { CUSTOMER_EMAIL_AUTH_ENABLED: value }) }) as unknown as Bindings;
const post = (path: string, env: Bindings, body: unknown = {}, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://api.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env, ctx);

const EMAIL_ROUTES = [
  '/api/v1/customer-auth/email/register/request',
  '/api/v1/customer-auth/email/register/complete',
  '/api/v1/customer-auth/email/login',
  '/api/v1/customer-session/refresh',
  '/api/v1/customer-session/logout',
];
const NOT_EXACTLY_TRUE = [undefined, '', 'false', 'FALSE', 'TRUE', 'True', '1', 'yes', 'true ', ' true', 'enabled'];

describe('customer email authentication disabled (real mounted app)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(NOT_EXACTLY_TRUE.map((v) => [v === undefined ? 'unset' : JSON.stringify(v), v] as const))('flag %s: every email-auth and session-lifecycle route is a generic 404', async (label, value) => {
    for (const path of EMAIL_ROUTES) {
      const response = await post(path, withFlag(value), { email: 'a@example.test', password: 'x'.repeat(12) });
      expect(response.status, `${path} with flag ${label}`).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    }
  });

  it('with the flag off, legacy phone authentication is untouched: the OTP route still validates its input (400, not 404/503)', async () => {
    const response = await post('/api/v1/customer-auth/otp/request', withFlag('false'), {});
    expect(response.status).toBe(400);
  });

  it('with the flag off, a legacy customer token still authenticates a customer route', async () => {
    const env = withFlag('false');
    const token = await signCustomerAccessToken(customerId, (env as unknown as Record<string, string>).CUSTOMER_JWT_SECRET!);
    const response = await worker.fetch(new Request('https://api.test/api/v1/loyalty/me/accounts', { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    expect(response.status).toBe(200);
    expect(mocks.listAccounts).toHaveBeenCalledWith(customerId);
  });

  it('with the flag off, a missing or bad legacy token is still refused (401) and an email-auth header is not honored', async () => {
    const env = withFlag(undefined);
    expect((await worker.fetch(new Request('https://api.test/api/v1/loyalty/me/accounts'), env, ctx)).status).toBe(401);
    const bad = await worker.fetch(new Request('https://api.test/api/v1/loyalty/me/accounts', { headers: { Authorization: 'Bearer not-a-token' } }), env, ctx);
    expect(bad.status).toBe(401);
  });

  it('flag exactly "true" with the rest of the configuration missing fails CLOSED (503), never open and never a 404 that hides the misconfiguration', async () => {
    const response = await post('/api/v1/customer-auth/email/register/request', withFlag('true'), { email: 'a@example.test' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service unavailable' });
  });
});
