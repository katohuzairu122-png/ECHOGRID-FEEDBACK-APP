import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { signAccessToken, signCashierAccessToken, signImpersonationToken } from '../auth/jwt';
import type { Bindings } from '../config/env';
import { signCustomerAccessToken } from '../customer-auth/customer-jwt';
import { errorHandler } from '../lib/error-handler';
import { platformAuditLogRoutes } from './audit-log.routes';
import { createNetworkModerationRoutes } from './network-moderation.routes';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  history: vi.fn(),
  audit: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({ createDb: async () => ({ db: {}, close: mocks.close }) }));
vi.mock('../repositories', () => ({
  createRepositories: () => ({
    users: { findById: mocks.user },
    auditLog: { listAllWithDetails: mocks.audit },
  }),
}));
vi.mock('../network/network-moderation-history', () => ({
  listNetworkModerationHistory: mocks.history,
}));

const secret = 'test-only-platform-history-access-secret';
const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const history = '/api/v1/platform/network-moderation/history';
const audit = '/api/v1/platform/audit-log';
const app = new Hono<{ Bindings: Bindings }>();
const release = vi.fn();
app.route(
  '/api/v1/platform/network-moderation',
  createNetworkModerationRoutes({
    open: async () => ({ db: {} as never, release }),
  }),
);
app.route(audit, platformAuditLogRoutes);
app.onError(errorHandler);

function request(
  path = history,
  {
    token,
    method = 'GET',
    flag = 'true',
  }: {
    token?: string;
    method?: string;
    flag?: string;
  } = {},
) {
  const headers = new Headers({ 'x-business-id': other });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return app.request(
    path,
    { method, headers },
    {
      JWT_ACCESS_SECRET: secret,
      NETWORK_FEED_ENABLED: flag,
      PLATFORM_IMPERSONATION_ENABLED: 'true',
    } as Bindings,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

const adminToken = () => signAccessToken(actor, secret);
const activeUser = (platformRole: 'admin' | 'billing' | 'support' | null) => ({
  status: 'active',
  platformRole,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue(activeUser('admin'));
  mocks.history.mockResolvedValue({ entries: [], nextCursor: null });
  mocks.audit.mockResolvedValue([]);
});

describe('moderation history HTTP contract', () => {
  it('reads an uncached page for a current platform moderator and rechecks the same token after demotion', async () => {
    const token = await adminToken();
    const allowed = await request(`${history}?cursor=${other}`, { token });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await allowed.json()).toEqual({
      success: true,
      data: { entries: [], nextCursor: null },
    });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith({}, other);
    expect(release).toHaveBeenCalledOnce();

    mocks.user.mockResolvedValue(activeUser(null));
    expect((await request(history, { token })).status).toBe(403);
    expect(mocks.history).toHaveBeenCalledOnce();
  });

  it.each([null, 'support', 'billing'] as const)(
    'denies a user with platform role %s even with a business header',
    async (role) => {
      mocks.user.mockResolvedValue(activeUser(role));
      expect((await request(history, { token: await adminToken() })).status).toBe(403);
      expect(mocks.history).not.toHaveBeenCalled();
    },
  );

  it('denies anonymous, customer, cashier, and impersonated-admin sessions', async () => {
    const customer = await signCustomerAccessToken(actor, secret);
    const cashier = await signCashierAccessToken(actor, secret, {
      sessionId: actor,
      businessId: other,
    });
    const impersonated = await signImpersonationToken(actor, other, secret);
    expect((await request()).status).toBe(401);
    expect((await request(history, { token: customer })).status).toBe(401);
    expect((await request(history, { token: cashier })).status).toBe(403);
    expect((await request(history, { token: impersonated.token })).status).toBe(403);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it.each([
    '?cursor=',
    '?cursor=xyz',
    `?cursor=${actor}&cursor=${other}`,
    '?limit=100000',
    '?businessId=any',
  ])('rejects unsupported pagination %s before accessing history', async (query) => {
    const response = await request(history + query, { token: await adminToken() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_HISTORY_PAGINATION' } });
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('has no mutation routes and preserves the feature-off response', async () => {
    const token = await adminToken();
    expect((await request(history, { token, flag: 'false' })).status).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await request(history, { token, method })).status).toBe(404);
    }
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it.each(['support', 'billing', 'admin'] as const)(
    'applies the same Network permission to %s on the legacy audit read',
    async (role) => {
      mocks.user.mockResolvedValue(activeUser(role));
      const response = await request(audit + '?entityType=network_post', {
        token: await adminToken(),
      });
      expect(response.status).toBe(200);
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'network_post',
          excludeNetworkModeration: role !== 'admin',
        }),
        expect.anything(),
      );
    },
  );
});
