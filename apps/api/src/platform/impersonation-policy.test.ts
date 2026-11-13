import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { isPlatformImpersonationEnabled } from './impersonation-policy';

/**
 * Real authentication middleware + real platform-role guard + real route.
 * Only database repositories are mocked, so a 403/401 cannot be created
 * by stubbing away the authorization boundary under test.
 */
const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  listForUserAtBusiness: vi.fn(),
  listBusinesses: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    users: { findById: mocks.findById },
    userBusinessRoles: { listForUserAtBusiness: mocks.listForUserAtBusiness },
    businesses: { list: mocks.listBusinesses },
  })),
}));

const { platformBusinessRoutes } = await import('./business-directory.routes');
const { signAccessToken, signImpersonationToken, verifyAccessToken } = await import('../auth/jwt');
const { errorHandler } = await import('../lib/error-handler');

const ACCESS_SECRET = 'test-only-platform-impersonation-gate-secret';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SUPPORT_ID = '22222222-2222-4222-8222-222222222222';
const BILLING_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_ID = '44444444-4444-4444-8444-444444444444';
const BUSINESS_ID = '55555555-5555-4555-8555-555555555555';

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/platform/businesses', platformBusinessRoutes);
app.onError(errorHandler);

const users = new Map([
  [ADMIN_ID, { id: ADMIN_ID, status: 'active', platformRole: 'admin', email: 'admin@example.test', fullName: 'Admin' }],
  [SUPPORT_ID, { id: SUPPORT_ID, status: 'active', platformRole: 'support', email: 'support@example.test', fullName: 'Support' }],
  [BILLING_ID, { id: BILLING_ID, status: 'active', platformRole: 'billing', email: 'billing@example.test', fullName: 'Billing' }],
  [TARGET_ID, { id: TARGET_ID, status: 'active', platformRole: null, email: 'target@example.test', fullName: 'Target' }],
]);

function env(flag?: string): Bindings {
  return {
    JWT_ACCESS_SECRET: ACCESS_SECRET,
    HYPERDRIVE: { connectionString: 'postgresql://test-unused' },
    ...(flag === undefined ? {} : { PLATFORM_IMPERSONATION_ENABLED: flag }),
  } as Bindings;
}

function executionCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

async function request(
  path: string,
  opts: {
    userId?: string;
    flag?: string;
    token?: string;
    method?: 'GET' | 'POST';
    body?: unknown;
  } = {},
): Promise<Response> {
  const token = opts.token ?? await signAccessToken(opts.userId ?? ADMIN_ID, ACCESS_SECRET);
  return app.request(
    `/api/v1/platform/businesses${path === '/' ? '' : path}`,
    {
      method: opts.method ?? 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    },
    env(opts.flag),
    executionCtx(),
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findById.mockImplementation(async (id: string) => users.get(id));
  mocks.listForUserAtBusiness.mockResolvedValue([{ roleId: 'mock-active-role-grant' }]);
  mocks.listBusinesses.mockResolvedValue([]);
});

describe('ACCESS-SEC-01A impersonation policy', () => {
  it('requires exact opt-in: missing/empty/false/TRUE/1 are all disabled', () => {
    for (const flag of [undefined, '', 'false', 'TRUE', '1', ' true ']) {
      expect(isPlatformImpersonationEnabled(env(flag))).toBe(false);
    }
    expect(isPlatformImpersonationEnabled(env('true'))).toBe(true);
  });

  it('denies new impersonation to an authenticated admin by default without issuing a token', async () => {
    const response = await request(`/${BUSINESS_ID}/impersonate`, {
      body: { userId: TARGET_ID, reason: 'test' },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('PLATFORM_IMPERSONATION_DISABLED');
    expect(mocks.listForUserAtBusiness).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it('cannot be enabled by a request body or query string', async () => {
    const response = await request(`/${BUSINESS_ID}/impersonate?PLATFORM_IMPERSONATION_ENABLED=true`, {
      body: {
        userId: TARGET_ID,
        reason: 'test',
        PLATFORM_IMPERSONATION_ENABLED: 'true',
      },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('PLATFORM_IMPERSONATION_DISABLED');
    expect(mocks.listForUserAtBusiness).not.toHaveBeenCalled();
  });

  it('does not weaken existing platform listing access while disabled', async () => {
    const response = await request('/', { method: 'GET', userId: ADMIN_ID });
    expect(response.status).toBe(200);
    expect(mocks.listBusinesses).toHaveBeenCalledOnce();
  });

  it('rejects an already issued impersonation JWT before any DB lookup when disabled', async () => {
    const { token } = await signImpersonationToken(TARGET_ID, ADMIN_ID, ACCESS_SECRET);
    const response = await request('/', { method: 'GET', token });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('UNAUTHENTICATED');
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('when explicitly enabled, still enforces SUPPORT/ADMIN authorization and target membership', async () => {
    const response = await request(`/${BUSINESS_ID}/impersonate`, {
      userId: SUPPORT_ID,
      flag: 'true',
      body: { userId: TARGET_ID, reason: 'owner-approved test only' },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data?: { accessToken?: string } };
    expect(typeof body.data?.accessToken).toBe('string');
    const claims = await verifyAccessToken(body.data!.accessToken!, ACCESS_SECRET);
    expect(claims.sub).toBe(TARGET_ID);
    expect(claims.impersonatedBy).toBe(SUPPORT_ID);
    expect(mocks.listForUserAtBusiness).toHaveBeenCalledWith(TARGET_ID, BUSINESS_ID);

    const billingResponse = await request(`/${BUSINESS_ID}/impersonate`, {
      userId: BILLING_ID,
      flag: 'true',
      body: { userId: TARGET_ID, reason: 'test' },
    });
    expect(billingResponse.status).toBe(403);
    expect(await errorCode(billingResponse)).toBe('PLATFORM_ROLE_DENIED');
  });

  it('never permits an impersonated token to access platform routes, even with flag enabled', async () => {
    const { token } = await signImpersonationToken(ADMIN_ID, SUPPORT_ID, ACCESS_SECRET);
    const response = await request('/', { method: 'GET', token, flag: 'true' });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('IMPERSONATED_PLATFORM_ACCESS_DENIED');
  });
});
