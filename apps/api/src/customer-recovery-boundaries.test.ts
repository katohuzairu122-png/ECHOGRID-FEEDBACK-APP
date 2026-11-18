import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from './config/env';

const mocks = vi.hoisted(() => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('./db/client', () => ({ createDb: mocks.createDb }));
vi.mock('./repositories', () => ({ createRepositories: () => ({}) }));
vi.mock('./middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  globalApiRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
  staffLoginRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  signupRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  passwordResetRequestRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  passwordResetConfirmRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  passwordChangeRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  cashierAuthRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  managedCashierLoginRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  adminReauthRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('./middleware/audit', () => ({ auditTrail: async (_c: unknown, next: () => Promise<void>) => next() }));

import worker from './index';

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const paths = ['initiate', 'email-challenge', 'email-verify', 'phone-otp', 'phone-verify', 'code-verify', 'cancel', 'complete'];
const call = (path: string, env: Record<string, unknown>, method = 'POST') =>
  worker.fetch(new Request(`https://api.test/api/v1/customer-recovery/${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }),
  }), env as unknown as Bindings, ctx);

describe('account recovery routes on the deployed worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(paths)('are a generic 404 for every method when the gate is not set (%s)', async (path) => {
    for (const method of ['POST', 'GET', 'PUT', 'DELETE']) {
      const response = await call(path, {}, method);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    }
    expect(mocks.createDb).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'TRUE', 'True', '1', 'yes', 'false', ' true'])('stay a 404 for gate value %j, never opening a database', async (value) => {
    for (const path of paths) expect((await call(path, { CUSTOMER_RECOVERY_ENABLED: value })).status).toBe(404);
    expect(mocks.createDb).not.toHaveBeenCalled();
  });

  it('answer 503 (fail closed) when the gate is on but nothing is configured, still without opening a database', async () => {
    for (const path of paths) {
      const response = await call(path, { CUSTOMER_RECOVERY_ENABLED: 'true' });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mocks.createDb).not.toHaveBeenCalled();
  });

  it('never sets a cookie or issues a session, even when refused', async () => {
    const response = await call('initiate', { CUSTOMER_RECOVERY_ENABLED: 'true' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(JSON.stringify(await response.json())).not.toMatch(/token|session|cookie/i);
  });
});
