import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import type { Bindings } from '../config/env';
import type { CustomerAuthVariables } from '../middleware/customer-authenticate';
import { consentRoutes } from './consent.routes';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../middleware/customer-authenticate', () => ({
  customerAuthenticate: async (c: Context<{ Variables: CustomerAuthVariables }>, next: Next) => {
    c.set('customerId', 'caller');
    await next();
  },
}));
vi.mock('../middleware/rate-limit', () => ({
  rateLimitByCustomer: () => async (_c: unknown, next: Next) => next(),
}));
vi.mock('../db/client', () => ({ createDb: async () => ({ db: {}, close: async () => {} }) }));
vi.mock('../repositories', () => ({
  createRepositories: () => ({ consentGrants: { listForCustomer: mocks.list } }),
}));

beforeEach(() => vi.clearAllMocks());
describe('GET /consents closed customer response', () => {
  it('projects only review fields and scopes queries to the authenticated customer', async () => {
    const now = new Date('2026-11-18T12:00:00Z');
    mocks.list.mockResolvedValue([
      {
        id: 'grant',
        customerId: 'caller',
        businessId: 'business',
        purpose: 'join_loyalty',
        scope: null,
        resourceType: null,
        resourceId: null,
        consentVersion: 'v1',
        status: 'active',
        grantedAt: now,
        expiresAt: null,
        revokedAt: null,
        consumedAt: null,
        createdAt: now,
        idempotencyKey: 'private-key',
        metadata: { private: 'raw metadata' },
        unexpected: 'private future column',
      },
    ]);
    const app = new Hono<{ Bindings: Bindings; Variables: CustomerAuthVariables }>();
    app.route('/consents', consentRoutes);
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      '/consents?customerId=foreign&limit=5&offset=2',
      {},
      {} as Bindings,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('caller', { limit: 5, offset: 2 });
    expect(await response.json()).toEqual({
      success: true,
      data: [
        {
          id: 'grant',
          businessId: 'business',
          purpose: 'join_loyalty',
          scope: null,
          resourceType: null,
          resourceId: null,
          consentVersion: 'v1',
          status: 'active',
          grantedAt: now.toISOString(),
          expiresAt: null,
          revokedAt: null,
          consumedAt: null,
        },
      ],
    });
  });
});
