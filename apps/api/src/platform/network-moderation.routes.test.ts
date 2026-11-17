import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { signAccessToken, signCashierAccessToken, signImpersonationToken } from '../auth/jwt';
import { signCustomerAccessToken } from '../customer-auth/customer-jwt';
import type { PlatformRole } from '../db/schema/users';
import { AppError } from '../lib/errors';
import { errorHandler } from '../lib/error-handler';

const adminId = '11111111-1111-4111-8111-111111111111';
const supportId = '22222222-2222-4222-8222-222222222222';
const businessId = '33333333-3333-4333-8333-333333333333';
const anotherBusinessId = '44444444-4444-4444-8444-444444444444';
const jwtSecret = 'test-only-network-moderation-secret';
const basePath = '/api/v1/platform/network-moderation';

const state = vi.hoisted(() => ({
  role: 'admin' as PlatformRole | null,
  findById: vi.fn(),
  close: vi.fn(async () => undefined),
  serviceError: undefined as Error | undefined,
  calls: [] as string[],
}));

// Exercise the real token verifier and platform middleware. Stub persistence
// so no moderation writes or access to tenant storage can occur.
vi.mock('../db/client', () => ({
  createDb: async () => ({ db: {}, close: state.close }),
}));
vi.mock('../repositories', () => ({
  createRepositories: () => ({ users: { findById: state.findById } }),
}));

vi.mock('../network/network-post.service', () => {
  const post = {
    id: 'p1',
    handle: 'A'.repeat(22),
    state: 'unpublished',
    pinned: false,
    publishedAt: null,
    expiresAt: null,
    liveRevisionId: null,
  };
  const make =
    (name: string, value: unknown) =>
    async (...args: unknown[]) => {
      state.calls.push(`${name}:${JSON.stringify(args.slice(0, 3))}`);
      if (state.serviceError && name === 'withdraw') throw state.serviceError;
      return value;
    };
  return {
    NetworkPostService: class {
      createDraft = make('createDraft', { post, revision: { id: 'r1', revisionNo: 1 } });
      saveDraft = make('saveDraft', { id: 'r2', revisionNo: 2, status: 'draft' });
      submit = make('submit', { id: 'r2', status: 'submitted', revisionNo: 2 });
      approve = make('approve', { status: 'recorded', approvals: 1, required: 2 });
      reject = make('reject', {
        id: 'r2',
        status: 'rejected',
        postId: 'p1',
        reasonCode: 'spam_or_duplicate',
      });
      suspend = make('suspend', post);
      lift = make('lift', post);
      withdraw = make('withdraw', post);
      pin = make('pin', post);
      unpin = make('unpin', post);
      queue = make('queue', []);
      findByHandle = make('findByHandle', post);
    },
  };
});

import { createNetworkModerationRoutes } from './network-moderation.routes';

const env = (flag: string | null) =>
  ({
    JWT_ACCESS_SECRET: jwtSecret,
    PLATFORM_IMPERSONATION_ENABLED: 'true',
    ...(flag !== null ? { NETWORK_FEED_ENABLED: flag } : {}),
  }) as Bindings;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
function app() {
  const a = new Hono<{ Bindings: Bindings }>();
  a.onError(errorHandler);
  a.route(
    basePath,
    createNetworkModerationRoutes({
      open: async () => ({ db: {} as never, release: () => undefined }),
    }),
  );
  return a;
}
const json = { 'content-type': 'application/json' };
const content = JSON.stringify({ body: 'Official note', contentLocale: 'en' });
const handle = 'A'.repeat(22);

const ROUTES: [string, string, string | undefined][] = [
  ['GET', '/queue', undefined],
  ['POST', '/posts', content],
  ['PUT', `/posts/${handle}/draft`, content],
  ['POST', `/posts/${handle}/submit`, undefined],
  ['POST', '/revisions/rev-1/approve', undefined],
  ['POST', '/revisions/rev-1/reject', JSON.stringify({ reasonCode: 'spam_or_duplicate' })],
  ['POST', `/posts/${handle}/suspend`, JSON.stringify({ reasonCode: 'spam_or_duplicate' })],
  ['POST', `/posts/${handle}/lift`, undefined],
  ['POST', `/posts/${handle}/withdraw`, undefined],
  ['POST', `/posts/${handle}/pin`, undefined],
  ['POST', `/posts/${handle}/unpin`, undefined],
];
let adminToken: string;
async function call(
  method: string,
  path: string,
  body: string | undefined,
  {
    flag = 'true',
    token = adminToken,
    business,
  }: {
    flag?: string | null;
    token?: string | null;
    business?: string;
  } = {},
) {
  const headers = new Headers(json);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (business) headers.set('x-business-id', business);
  return app().request(
    basePath + path,
    { method, headers, ...(body ? { body } : {}) },
    env(flag),
    ctx,
  );
}

async function expectDenial(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ success: false, error: { code } });
  expect(state.calls).toEqual([]);
}

describe('platform network moderation routes', () => {
  beforeEach(async () => {
    state.role = 'admin';
    state.serviceError = undefined;
    state.calls = [];
    state.findById.mockReset().mockImplementation(async (id: string) => ({
      id,
      status: 'active',
      platformRole: id === supportId ? 'support' : state.role,
    }));
    adminToken = await signAccessToken(adminId, jwtSecret);
  });

  it.each(ROUTES)(
    '%s %s is a generic 404 with the flag off, before authentication or any service call',
    async (method, path, body) => {
      for (const flag of [null, 'false', 'TRUE', '1', 'yes', ' true']) {
        const response = await call(method, path, body, { flag });
        expect(response.status).toBe(404);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          'NOT_FOUND',
        );
      }
      expect(state.findById).not.toHaveBeenCalled();
      expect(state.calls).toEqual([]);
    },
  );

  it.each(ROUTES)('%s %s refuses support and billing roles', async (method, path, body) => {
    for (const role of ['support', 'billing'] as const) {
      state.role = role;
      const response = await call(method, path, body);
      expect(response.status).toBe(403);
    }
    expect(state.calls).toEqual([]);
  });

  it.each(ROUTES)('%s %s works for a platform admin when enabled', async (method, path, body) => {
    const response = await call(method, path, body);
    expect(response.status).toBeLessThan(300);
    expect(state.calls.length).toBeGreaterThan(0);
  });

  it('passes the authenticated admin as actor and never a client-supplied id', async () => {
    await call('POST', '/posts', JSON.stringify({ body: 'x', contentLocale: 'en' }));
    expect(state.calls[0]).toContain('11111111-1111-4111-8111-111111111111');
    for (const bad of [
      { body: 'x', contentLocale: 'en', authorUserId: 'someone' },
      { body: 'x', contentLocale: 'xx' },
      { contentLocale: 'en' },
    ]) {
      state.calls = [];
      expect((await call('POST', '/posts', JSON.stringify(bad))).status).toBe(400);
      expect(state.calls).toEqual([]);
    }
  });

  it('rejects an unknown field on reason bodies and a missing reason', async () => {
    expect(
      (
        await call(
          'POST',
          '/revisions/rev-1/reject',
          JSON.stringify({ reasonCode: 'spam_or_duplicate', actor: 'x' }),
        )
      ).status,
    ).toBe(400);
    expect((await call('POST', '/revisions/rev-1/reject', '{}')).status).toBe(400);
  });

  it.each(ROUTES)(
    '%s %s refuses a business identity regardless of the business header',
    async (method, path, body) => {
      state.role = null;
      for (const business of [businessId, anotherBusinessId]) {
        await expectDenial(
          await call(method, path, body, { business }),
          403,
          'PLATFORM_ACCESS_DENIED',
        );
      }
    },
  );

  it.each(ROUTES)(
    '%s %s refuses cashier and impersonated admin credentials',
    async (method, path, body) => {
      const cashier = await signCashierAccessToken(adminId, jwtSecret, {
        businessId,
        sessionId: '55555555-5555-4555-8555-555555555555',
      });
      const { token: impersonated } = await signImpersonationToken(adminId, supportId, jwtSecret);

      await expectDenial(
        await call(method, path, body, { token: cashier, business: businessId }),
        403,
        'CASHIER_ROUTE_DENIED',
      );
      await expectDenial(
        await call(method, path, body, { token: impersonated }),
        403,
        'IMPERSONATED_PLATFORM_ACCESS_DENIED',
      );
    },
  );

  it('refuses anonymous and customer credentials before opening the moderation service', async () => {
    const customerToken = await signCustomerAccessToken(adminId, jwtSecret);
    for (const token of [null, customerToken]) {
      await expectDenial(await call('GET', '/queue', undefined, { token }), 401, 'UNAUTHENTICATED');
    }
    expect(state.findById).not.toHaveBeenCalled();
  });

  it('resolves current platform authority again for the same access token', async () => {
    const queue = await call('GET', '/queue', undefined);
    expect(queue.status).toBe(200);
    expect(queue.headers.get('cache-control')).toBe('private, no-store');

    state.role = null;
    state.calls = [];
    await expectDenial(await call('GET', '/queue', undefined), 403, 'PLATFORM_ACCESS_DENIED');
  });

  it('preserves the service conflict when a post can no longer be withdrawn', async () => {
    state.serviceError = new AppError(
      'That action is not available for this post.',
      409,
      'NETWORK_STATE_CONFLICT',
    );
    const response = await call('POST', `/posts/${handle}/withdraw`, undefined);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'NETWORK_STATE_CONFLICT' },
    });
  });
});
