import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../config/env';
import { signCustomerAccessToken } from '../customer-auth/customer-jwt';

const mocks = vi.hoisted(() => ({
  findCustomer: vi.fn(async () => ({ status: 'active', preferredLocale: 'fr' as string | null })),
  setPreferredLocale: vi.fn(async (_id: string, locale: string) => ({ preferredLocale: locale })),
  findUser: vi.fn(),
}));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('../repositories', () => ({ createRepositories: () => ({
  customers: { findById: mocks.findCustomer, setPreferredLocale: mocks.setPreferredLocale },
  users: { findById: mocks.findUser },
}) }));
vi.mock('../middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../middleware/audit', () => ({ auditTrail: async (_c: unknown, next: () => Promise<void>) => next() }));

import worker from '../index';

const customerId = '11111111-1111-4111-8111-111111111111';
const env = { CUSTOMER_JWT_SECRET: 'customer-test-secret', JWT_ACCESS_SECRET: 'staff-test-secret' } as Bindings;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const url = 'https://api.test/api/v1/customer-language';

async function call(method: string, body?: unknown, auth = true) {
  const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
  return worker.fetch(new Request(url, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx);
}

describe('customer language preference routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a customer session', async () => {
    expect((await call('GET', undefined, false)).status).toBe(401);
    expect((await call('PUT', { locale: 'fr' }, false)).status).toBe(401);
    expect(mocks.setPreferredLocale).not.toHaveBeenCalled();
  });

  it('returns the caller saved locale (or null)', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { locale: 'fr' } });
  });

  it('saves a supported locale for the authenticated customer only', async () => {
    const res = await call('PUT', { locale: 'ar', customerId: 'someone-else' });
    expect(res.status).toBe(200);
    expect(mocks.setPreferredLocale).toHaveBeenCalledWith(customerId, 'ar');
  });

  it.each([{ locale: 'de' }, { locale: '' }, {}, { locale: null }])('rejects invalid body %j', async (body) => {
    const res = await call('PUT', body);
    expect(res.status).toBe(400);
    expect(mocks.setPreferredLocale).not.toHaveBeenCalled();
  });

  it('does not run staff authentication', async () => {
    await call('GET');
    expect(mocks.findUser).not.toHaveBeenCalled();
  });
});
