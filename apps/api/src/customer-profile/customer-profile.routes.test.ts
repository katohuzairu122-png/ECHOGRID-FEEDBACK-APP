import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../config/env';
import { signCustomerAccessToken } from '../customer-auth/customer-jwt';

const row = { displayName: 'Amina', bio: 'Hello', avatarKey: 'leaf', fullName: 'Amina Kato', email: 'amina@example.com', phone: null as string | null, status: 'active' };
const mocks = vi.hoisted(() => ({
  findCustomer: vi.fn(),
  setGlobalProfile: vi.fn(),
  findUser: vi.fn(),
}));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('../repositories', () => ({ createRepositories: () => ({
  customers: { findById: mocks.findCustomer, setGlobalProfile: mocks.setGlobalProfile },
  customerDeletionRequests: { findPending: async () => null },
  users: { findById: mocks.findUser },
}) }));
vi.mock('../middleware/rate-limit', () => ({
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
vi.mock('../middleware/audit', () => ({ auditTrail: async (_c: unknown, next: () => Promise<void>) => next() }));

import worker from '../index';

const customerId = '11111111-1111-4111-8111-111111111111';
const env = { CUSTOMER_JWT_SECRET: 'customer-test-secret', JWT_ACCESS_SECRET: 'staff-test-secret' } as Bindings;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

async function call(method: string, body?: unknown, auth = true) {
  const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
  return worker.fetch(new Request('https://api.test/api/v1/customer-profile', {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx);
}

describe('customer profile routes (PROF-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCustomer.mockResolvedValue(row);
    mocks.setGlobalProfile.mockImplementation(async (_id: string, patch: object) => ({ ...row, ...patch }));
  });

  it('requires a customer session', async () => {
    expect((await call('GET', undefined, false)).status).toBe(401);
    expect((await call('PUT', { bio: 'x' }, false)).status).toBe(401);
    expect(mocks.setGlobalProfile).not.toHaveBeenCalled();
  });

  it('returns the caller profile with a masked login and never the raw e-mail or phone', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ success: true, data: { displayName: 'Amina', avatarKey: 'leaf', fullName: 'Amina Kato', maskedLogin: 'a***@example.com' } });
    expect(text).not.toContain('amina@example.com');
  });

  it('saves only the authenticated customer and only the fields sent', async () => {
    const res = await call('PUT', { bio: 'New bio', avatarKey: 'sun' });
    expect(res.status).toBe(200);
    expect(mocks.setGlobalProfile).toHaveBeenCalledWith(customerId, { bio: 'New bio', avatarKey: 'sun' });
  });

  it('ignores an attempt to name another customer by rejecting the unknown field', async () => {
    const res = await call('PUT', { bio: 'x', customerId: 'someone-else' });
    expect(res.status).toBe(400);
    expect(mocks.setGlobalProfile).not.toHaveBeenCalled();
  });

  it.each([{}, { displayName: 'https://evil.example' }, { avatarKey: 'photo.png' }, { bio: 'x'.repeat(281) }])('rejects invalid body %j', async (body) => {
    expect((await call('PUT', body)).status).toBe(400);
    expect(mocks.setGlobalProfile).not.toHaveBeenCalled();
  });

  it('hides an avatar key that is no longer in the catalogue instead of returning it', async () => {
    mocks.findCustomer.mockResolvedValue({ ...row, avatarKey: 'retired-avatar' });
    const res = await call('GET');
    expect((await res.json() as { data: { avatarKey: unknown } }).data.avatarKey).toBeNull();
  });
});
