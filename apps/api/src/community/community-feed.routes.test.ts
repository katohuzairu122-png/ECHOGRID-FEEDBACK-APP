import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { signCustomerAccessToken } from '../customer-auth/customer-jwt';
import { errorHandler } from '../lib/error-handler';
import type { FeedItemDto, FeedSource } from './community-feed';

const mocks = vi.hoisted(() => ({
  findCustomer: vi.fn(async (_id: string) => ({ status: 'active' as 'active' | 'suspended' })),
}));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('../repositories', () => ({
  createRepositories: () => ({ customers: { findById: mocks.findCustomer } }),
}));
vi.mock('../middleware/rate-limit', () => ({
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { createCommunityFeedRoutes, communityFeedRoutes } from './community-feed.routes';

const customerId = '11111111-1111-4111-8111-111111111111';
const env = { CUSTOMER_JWT_SECRET: 'customer-test-secret' } as Bindings;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function appWith(source: FeedSource, enabled = true) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError(errorHandler);
  app.route('/network', createCommunityFeedRoutes({ isEnabled: () => enabled, openSource: async () => ({ source }) }));
  return app;
}

async function get(app: Hono<{ Bindings: Bindings }>, query = '', authed = true) {
  const headers: Record<string, string> = {};
  if (authed) headers.Authorization = `Bearer ${await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET)}`;
  return app.fetch(new Request(`https://api.test/network/feed${query}`, { headers }), env, ctx);
}

const item: FeedItemDto = {
  handle: 'abcdefghijklmnopqrstuv',
  contentClass: 'official',
  businessName: null,
  body: 'Official notice',
  linkUrl: 'https://echogrid.example/notice',
  contentLocale: 'en',
  publishedAt: '2026-11-16T00:00:00.000Z',
};

describe('GET /network/feed (COMMUNITY-01 foundation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCustomer.mockResolvedValue({ status: 'active' });
  });

  it('refuses anonymous callers and never calls the source', async () => {
    const listVisible = vi.fn();
    const response = await get(appWith({ listVisible }), '', false);
    expect(response.status).toBe(401);
    expect(listVisible).not.toHaveBeenCalled();
  });

  it('refuses a suspended customer', async () => {
    mocks.findCustomer.mockResolvedValue({ status: 'suspended' });
    const listVisible = vi.fn();
    expect((await get(appWith({ listVisible }))).status).toBe(401);
    expect(listVisible).not.toHaveBeenCalled();
  });

  it('the mounted instance is disabled by default: feed is a generic 404 and status says disabled', async () => {
    const app = new Hono<{ Bindings: Bindings }>();
    app.onError(errorHandler);
    app.route('/network', communityFeedRoutes);
    expect((await get(app)).status).toBe(404);
    const status = await app.fetch(new Request('https://api.test/network/status', {
      headers: { Authorization: `Bearer ${await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET)}` },
    }), env, ctx);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ success: true, data: { enabled: false } });
  });

  it('with the flag off the feed never touches the source, whatever the query', async () => {
    const listVisible = vi.fn();
    expect((await get(appWith({ listVisible }, false), '?limit=5')).status).toBe(404);
    expect(listVisible).not.toHaveBeenCalled();
  });

  it('reports enabled status to an authenticated customer only', async () => {
    const app = appWith({ listVisible: vi.fn() });
    const anonymous = await app.fetch(new Request('https://api.test/network/status'), env, ctx);
    expect(anonymous.status).toBe(401);
    const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
    const ok = await app.fetch(new Request('https://api.test/network/status', { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    expect(await ok.json()).toEqual({ success: true, data: { enabled: true } });
  });

  it('passes only the session customer id, the validated limit and cursor to the source', async () => {
    const listVisible = vi.fn(async () => ({ items: [item], nextCursor: 'next_1' }));
    const response = await get(appWith({ listVisible }), '?limit=5&cursor=abc_123');
    expect(response.status).toBe(200);
    expect(listVisible).toHaveBeenCalledWith({ customerId, cursor: 'abc_123', limit: 5 });
    expect(await response.json()).toEqual({ success: true, data: { items: [item], nextCursor: 'next_1' } });
  });

  it('uses the default limit when none is supplied', async () => {
    const listVisible = vi.fn(async () => ({ items: [], nextCursor: null }));
    await get(appWith({ listVisible }));
    expect(listVisible).toHaveBeenCalledWith({ customerId, cursor: null, limit: 20 });
  });

  it.each([
    ['client-supplied customer id', `?customerId=${customerId}`],
    ['client-supplied business id', '?businessId=22222222-2222-4222-8222-222222222222'],
    ['limit above the maximum', '?limit=51'],
    ['limit zero', '?limit=0'],
    ['non-numeric limit', '?limit=abc'],
    ['malformed cursor', '?cursor=a%20b'],
    ['oversized cursor', `?cursor=${'a'.repeat(201)}`],
  ])('rejects %s before touching the source', async (_name, query) => {
    const listVisible = vi.fn();
    const response = await get(appWith({ listVisible }), query);
    expect(response.status).toBe(400);
    expect(listVisible).not.toHaveBeenCalled();
  });

  it('fails closed with a generic 503 when the source throws', async () => {
    const listVisible = vi.fn(async () => {
      throw new Error('secret database detail');
    });
    const response = await get(appWith({ listVisible }));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('FEED_UNAVAILABLE');
    expect(text).not.toContain('secret database detail');
  });

  it('strips fields outside the closed DTO', async () => {
    const leaky = { ...item, businessId: 'b-1', reviewerId: 'u-1', reportCount: 3 } as FeedItemDto;
    const listVisible = vi.fn(async () => ({ items: [leaky], nextCursor: null }));
    const body = (await (await get(appWith({ listVisible }))).json()) as { data: { items: object[] } };
    expect(body.data.items[0]).toEqual(item);
    expect(JSON.stringify(body)).not.toMatch(/businessId|reviewerId|reportCount/);
  });

  it.each([
    ['non-https link', { ...item, linkUrl: 'http://example.test/x' }],
    ['script link', { ...item, linkUrl: 'javascript:alert(1)' }],
    ['bad handle', { ...item, handle: 'short' }],
    ['unknown class', { ...item, contentClass: 'customer_post' as never }],
    ['empty body', { ...item, body: '' }],
    ['bad time', { ...item, publishedAt: 'yesterday' }],
  ])('fails closed on a contract-violating item (%s)', async (_name, bad) => {
    const listVisible = vi.fn(async () => ({ items: [bad as FeedItemDto], nextCursor: null }));
    expect((await get(appWith({ listVisible }))).status).toBe(503);
  });

  it('fails closed when the source returns more items than requested', async () => {
    const listVisible = vi.fn(async () => ({ items: [item, item], nextCursor: null }));
    expect((await get(appWith({ listVisible }), '?limit=1')).status).toBe(503);
  });

  it('exposes no write method: publishing is not available', async () => {
    const app = appWith({ listVisible: vi.fn() });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const token = await signCustomerAccessToken(customerId, env.CUSTOMER_JWT_SECRET);
      const response = await app.fetch(
        new Request('https://api.test/network/feed', { method, headers: { Authorization: `Bearer ${token}` } }),
        env,
        ctx,
      );
      expect(response.status).toBe(404);
    }
  });
});
