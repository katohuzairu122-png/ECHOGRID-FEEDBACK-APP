import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from './config/env';
import { signCustomerAccessToken } from './customer-auth/customer-jwt';

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(async () => []),
  listConversations: vi.fn(async () => []),
  findConversation: vi.fn(async () => ({ id: 'thread-a' })),
  listMessages: vi.fn(async () => []),
  unreadSummaryForCustomer: vi.fn(async () => [] as { businessId: string; unreadMessages: number }[]),
  listParticipations: vi.fn(async () => []),
  getCommunityStatus: vi.fn(async () => null),
  getCommunityPointAccount: vi.fn(async () => undefined),
  listCommunityPointTransactions: vi.fn(async () => []),
  findCustomer: vi.fn(async () => ({ status: 'active' })),
  findUser: vi.fn(),
}));
vi.mock('./db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('./repositories', () => ({ createRepositories: () => ({
  customers: { findById: mocks.findCustomer },
  users: { findById: mocks.findUser },
  loyaltyAccounts: { listForCustomer: mocks.listAccounts },
  conversations: {
    listForCustomer: mocks.listConversations,
    findByCustomerAndBusiness: mocks.findConversation,
    unreadSummaryForCustomer: mocks.unreadSummaryForCustomer,
  },
  messages: { listForConversation: mocks.listMessages },
  surveyParticipations: { listForCustomer: mocks.listParticipations },
  communityMemberships: { findByCustomerId: mocks.getCommunityStatus },
  communityPointAccounts: { findByCustomerId: mocks.getCommunityPointAccount },
  communityPointTransactions: { listForCustomer: mocks.listCommunityPointTransactions },
}) }));
vi.mock('./middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
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
    ['/api/v1/surveys/me/participations', mocks.listParticipations],
  ] as const)('accepts a customer session at %s without staff authentication', async (path, list) => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(new Request(`https://api.test${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: [] });
    if (path === '/api/v1/surveys/me/participations') {
      expect(list).toHaveBeenCalledWith(customerId, { limit: 100, offset: 0 });
    } else if (path === '/api/v1/messaging/me/conversations') {
      expect(list).toHaveBeenCalledWith(customerId, { limit: 100, offset: 0 });
    } else {
      expect(list).toHaveBeenCalledWith(customerId);
    }
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('serves the customer unread summary from a customer session, scoped to that customer, and refuses anonymous callers', async () => {
    const anonymous = await worker.fetch(new Request('https://api.test/api/v1/messaging/me/unread-count'), env, ctx);
    expect(anonymous.status).toBe(401);
    expect(mocks.unreadSummaryForCustomer).not.toHaveBeenCalled();

    mocks.unreadSummaryForCustomer.mockResolvedValueOnce([
      { businessId: 'business-a', unreadMessages: 2 },
      { businessId: 'business-b', unreadMessages: 1 },
    ]);
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(
      new Request('https://api.test/api/v1/messaging/me/unread-count', { headers: { Authorization: `Bearer ${token}` } }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        unreadMessages: 3,
        unreadConversations: 2,
        byBusiness: [
          { businessId: 'business-a', unreadMessages: 2 },
          { businessId: 'business-b', unreadMessages: 1 },
        ],
      },
    });
    expect(mocks.unreadSummaryForCustomer).toHaveBeenCalledWith(customerId);
  });

  it.each([
    ['/api/v1/messaging/me/conversations', mocks.listConversations, false],
    ['/api/v1/messaging/me/conversations/business-a/messages', mocks.listMessages, true],
  ] as const)('DEV-101/102 applies explicit bounded customer paging at %s', async (path, method, isMessageList) => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(new Request(`https://api.test${path}?limit=25&offset=50`, {
      headers: { Authorization: `Bearer ${token}` },
    }), env, ctx);
    expect(response.status).toBe(200);
    if (isMessageList) {
      expect(mocks.findConversation).toHaveBeenCalledWith(customerId, 'business-a');
      expect(method).toHaveBeenCalledWith('thread-a', { limit: 25, offset: 50 });
    } else {
      expect(method).toHaveBeenCalledWith(customerId, { limit: 25, offset: 50 });
    }
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('DEV-102 defaults customer messages to a 100-row bounded page', async () => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(new Request('https://api.test/api/v1/messaging/me/conversations/business-a/messages', {
      headers: { Authorization: `Bearer ${token}` },
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(mocks.listMessages).toHaveBeenCalledWith('thread-a', { limit: 100, offset: 0 });
  });

  it.each([
    '/api/v1/messaging/me/conversations',
    '/api/v1/messaging/me/conversations/business-a/messages',
  ])('DEV-103 rejects malformed customer paging before fetching conversation data: %s', async (path) => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=1000001', 'limit=1&limit=2']) {
      vi.clearAllMocks();
      const response = await worker.fetch(new Request(`https://api.test${path}?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      }), env, ctx);
      expect(response.status).toBe(400);
      expect(mocks.listConversations).not.toHaveBeenCalled();
      expect(mocks.findConversation).not.toHaveBeenCalled();
      expect(mocks.listMessages).not.toHaveBeenCalled();
    }
  });

  it('accepts a customer session at /api/v1/community/me without staff authentication', async () => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(new Request('https://api.test/api/v1/community/me', {
      headers: { Authorization: `Bearer ${token}` },
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { membership: null, account: null },
    });
    expect(mocks.getCommunityStatus).toHaveBeenCalledWith(customerId);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('accepts a customer session at /api/v1/community-points/me without staff authentication', async () => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(
      new Request('https://api.test/api/v1/community-points/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { account: null },
    });
    expect(mocks.getCommunityPointAccount).toHaveBeenCalledWith(customerId);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('lists only the authenticated customer Community Point history', async () => {
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const response = await worker.fetch(
      new Request('https://api.test/api/v1/community-points/me/transactions?limit=20&offset=0', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        transactions: [],
        pagination: { limit: 20, offset: 0, returned: 0 },
      },
    });
    expect(mocks.listCommunityPointTransactions).toHaveBeenCalledWith(
      customerId,
      { limit: 20, offset: 0 },
    );
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it.each(['/api/v1/loyalty/accounts', '/api/v1/messaging/conversations', '/api/v1/surveys'])(
    'still rejects customer credentials on staff route %s', async (path) => {
      const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
      const response = await worker.fetch(new Request(`https://api.test${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      }), env, ctx);
      expect(response.status).toBe(401);
      expect(mocks.listAccounts).not.toHaveBeenCalled();
      expect(mocks.listConversations).not.toHaveBeenCalled();
      expect(mocks.listParticipations).not.toHaveBeenCalled();
    },
  );
});
