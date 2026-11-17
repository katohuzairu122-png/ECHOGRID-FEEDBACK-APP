import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { signAccessToken, signCashierAccessToken, signImpersonationToken } from '../auth/jwt';
import type { Bindings } from '../config/env';
import { signCustomerAccessToken } from '../customer-auth/customer-jwt';
import { errorHandler } from '../lib/error-handler';
import { createNetworkModerationRoutes } from './network-moderation.routes';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  close: vi.fn(async () => undefined),
}));
vi.mock('../db/client', () => ({ createDb: async () => ({ db: {}, close: mocks.close }) }));
vi.mock('../repositories', () => ({
  createRepositories: () => ({ users: { findById: mocks.findUser } }),
}));
vi.mock('../network/network-saved-drafts', () => ({
  listNetworkSavedDrafts: mocks.list,
  getNetworkSavedDraft: mocks.read,
}));

const secret = 'test-only-saved-draft-access-secret';
const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const handle = 'A'.repeat(22);
const draft = { handle, body: 'Saved content', contentLocale: 'en', linkUrl: null };
const base = '/api/v1/platform/network-moderation';
const app = new Hono<{ Bindings: Bindings }>();
const open = vi.fn(async () => ({ db: {} as never, release: () => undefined }));
app.route(base, createNetworkModerationRoutes({ open }));
app.onError(errorHandler);

let token: string;
function request(path: string, credential = token, { flag = 'true', method = 'GET' } = {}) {
  return app.request(
    base + path,
    {
      method,
      headers: { authorization: `Bearer ${credential}`, 'x-business-id': other },
    },
    {
      JWT_ACCESS_SECRET: secret,
      NETWORK_FEED_ENABLED: flag,
      PLATFORM_IMPERSONATION_ENABLED: 'true',
    } as Bindings,
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.findUser.mockResolvedValue({ status: 'active', platformRole: 'admin' });
  mocks.list.mockResolvedValue({ entries: [], nextCursor: null });
  mocks.read.mockResolvedValue(draft);
  token = await signAccessToken(actor, secret);
});

describe('saved draft retrieval', () => {
  it('scopes both reads to the authenticated actor and prevents caching', async () => {
    const createdAt = '2026-11-17T12:00:00.000Z';
    const list = await request(
      '/drafts?' + new URLSearchParams({ cursor: `${createdAt}~${handle}` }),
    );
    const detail = await request(`/drafts/${handle}`);
    for (const response of [list, detail]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({}, actor, { createdAt, handle });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({}, actor, handle);
    expect(await detail.json()).toEqual({ success: true, data: draft });
  });

  it.each([null, 'support', 'billing'])(
    'denies %s even with a supplied business context',
    async (platformRole) => {
      mocks.findUser.mockResolvedValue({ status: 'active', platformRole });
      for (const path of ['/drafts', `/drafts/${handle}`]) {
        expect((await request(path)).status).toBe(403);
      }
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('denies anonymous, customer, cashier, and impersonated moderator credentials', async () => {
    const customer = await signCustomerAccessToken(actor, secret);
    const cashier = await signCashierAccessToken(actor, secret, {
      sessionId: actor,
      businessId: other,
    });
    const impersonated = await signImpersonationToken(actor, other, secret);
    for (const path of ['/drafts', `/drafts/${handle}`]) {
      for (const [credential, status] of [
        ['', 401],
        [customer, 401],
        [cashier, 403],
        [impersonated.token, 403],
      ] as const) {
        expect((await request(path, credential)).status).toBe(status);
      }
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('revalidates both reads after loss of authority, including with the same valid token', async () => {
    expect((await request('/drafts')).status).toBe(200);
    expect((await request(`/drafts/${handle}`)).status).toBe(200);
    mocks.findUser.mockResolvedValue({ status: 'active', platformRole: null });
    expect((await request('/drafts')).status).toBe(403);
    expect((await request(`/drafts/${handle}`)).status).toBe(403);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each([
    '?cursor=',
    '?cursor=invalid',
    '?cursor=invalid&cursor=also-invalid',
    '?limit=10000',
    '?businessId=other',
  ])('rejects unbounded or malformed selection %s', async (query) => {
    const response = await request('/drafts' + query);
    expect(response.status).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it('returns the same response for invalid and inaccessible handles', async () => {
    mocks.read.mockResolvedValue(null);
    const inaccessible = await request(`/drafts/${handle}`);
    const invalid = await request('/drafts/invalid');
    expect(inaccessible.status).toBe(404);
    expect(invalid.status).toBe(404);
    expect(await inaccessible.json()).toEqual(await invalid.json());
    expect(open).toHaveBeenCalledOnce();
  });

  it('keeps the flag gate and registers no writes for either retrieval path', async () => {
    for (const path of ['/drafts', `/drafts/${handle}`]) {
      expect((await request(path, token, { flag: 'false' })).status).toBe(404);
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        expect((await request(path, token, { method })).status).toBe(404);
      }
    }
    expect(open).not.toHaveBeenCalled();
  });
});
