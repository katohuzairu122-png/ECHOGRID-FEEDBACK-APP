import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from './config/env';
import { signCustomerAccessToken } from './customer-auth/customer-jwt';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(async () => []),
  listConversations: vi.fn(async () => []),
  findCustomer: vi.fn(async () => ({ status: 'active' })),
  findUser: vi.fn(),
}));
vi.mock('./db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('./repositories', () => ({ createRepositories: () => ({
  customers: { findById: mocks.findCustomer },
  users: { findById: mocks.findUser },
  loyaltyAccounts: { listForCustomer: mocks.listAccounts },
  conversations: { listForCustomer: mocks.listConversations },
}) }));
vi.mock('./middleware/rate-limit', () => ({ rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('./middleware/audit', () => ({ auditTrail: async (_c: unknown, next: () => Promise<void>) => next() }));

import worker from './index';

const customerId = '11111111-1111-4111-8111-111111111111';
const env = { CUSTOMER_JWT_SECRET: 'customer-test-secret', JWT_ACCESS_SECRET: 'staff-test-secret' } as Bindings;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

describe('mounted customer and staff route boundaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['/api/v1/loyalty/me/accounts', mocks.listAccounts],
    ['/api/v1/messaging/me/conversations', mocks.listConversations],
  ] as const)('accepts a customer session at %s without staff authentication', async (path, list) => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(new Request(`https://api.test${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: [] });
    expect(list).toHaveBeenCalledWith(customerId);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it.each(['/api/v1/loyalty/accounts', '/api/v1/messaging/conversations'])(
    'still rejects customer credentials on staff route %s', async (path) => {
      const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
      const response = await worker.fetch(new Request(`https://api.test${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      }), env, ctx);
      expect(response.status).toBe(401);
      expect(mocks.listAccounts).not.toHaveBeenCalled();
      expect(mocks.listConversations).not.toHaveBeenCalled();
    },
  );
});
