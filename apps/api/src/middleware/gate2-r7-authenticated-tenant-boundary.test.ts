import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { AppError } from '../lib/errors';

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  membership: vi.fn(),
  business: vi.fn(),
  branch: vi.fn(),
  permissions: vi.fn(),
  writes: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    users: { findById: mocks.users },
    userBusinessRoles: { listForUserAtBusiness: mocks.membership },
    businesses: { findById: mocks.business },
    branches: { findById: mocks.branch },
    permissions: { findEffectiveKeys: mocks.permissions },
  })),
}));

const { authenticate } = await import('./authenticate');
const { resolveTenantContext } = await import('./tenant-context');
const { requirePermission } = await import('./require-permission');
const { requireBusinessWideAccess } = await import('./require-business-wide-access');
const { signAccessToken } = await import('../auth/jwt');

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };
const JWT_SECRET = 'gate2-r7-disposable-jwt-secret';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const BUSINESS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUSINESS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRANCH_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BRANCH_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const env = {
  JWT_ACCESS_SECRET: JWT_SECRET,
  HYPERDRIVE: { connectionString: 'postgresql://unused-in-mocked-test' },
} as unknown as Bindings;

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authenticate, resolveTenantContext);
  instance.get('/feedback', requirePermission('feedback:view'), c =>
    c.json({ businessId: c.get('businessId'), userId: c.get('userId'), branchId: c.get('branchId') ?? null }),
  );
  instance.post('/feedback/review', requireBusinessWideAccess, requirePermission('feedback:manage'), c => {
    mocks.writes();
    return c.json({ ok: true, businessId: c.get('businessId') });
  });
  instance.onError((err, c) => c.json(
    { code: err instanceof AppError ? err.code : 'UNEXPECTED' },
    err instanceof AppError ? err.status : 500,
  ));
  return instance;
}

function executionCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}
async function request(opts: {
  user?: string;
  token?: string;
  business?: string;
  branch?: string;
  method?: 'GET' | 'POST';
  path?: string;
  extraHeaders?: Record<string, string>;
}) {
  const headers = new Headers(opts.extraHeaders);
  if (opts.user) headers.set('authorization', `Bearer ${await signAccessToken(opts.user, JWT_SECRET)}`);
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  if (opts.business) headers.set('X-Business-Id', opts.business);
  if (opts.branch) headers.set('X-Branch-Id', opts.branch);
  return app().request(opts.path ?? '/feedback', { headers, method: opts.method ?? 'GET' }, env, executionCtx());
}

describe('Gate 2 R7 authenticated staff/tenant request boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.users.mockImplementation(async (id: string) => ({ id, status: 'active' }));
    mocks.membership.mockImplementation(async (userId: string, businessId: string) =>
      (userId === USER_A && businessId === BUSINESS_A) ||
      (userId === USER_B && businessId === BUSINESS_B)
        ? [{ branchId: null }]
        : [],
    );
    mocks.business.mockResolvedValue({ status: 'active' });
    mocks.branch.mockImplementation(async (id: string, businessId: string) =>
      (id === BRANCH_A && businessId === BUSINESS_A) ||
      (id === BRANCH_B && businessId === BUSINESS_B)
        ? { id, businessId }
        : undefined,
    );
    mocks.permissions.mockImplementation(async (userId: string, businessId: string) =>
      (userId === USER_A && businessId === BUSINESS_A) ||
      (userId === USER_B && businessId === BUSINESS_B)
        ? new Set(['feedback:view', 'feedback:manage'])
        : new Set(),
    );
  });

  it('R7-01 requires a real valid staff access token before any tenant lookup', async () => {
    const absent = await request({ business: BUSINESS_A });
    const forged = await request({ business: BUSINESS_A, token: 'fake-not-a-jwt' });
    expect(absent.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it('R7-02 binds header business selection to the verified token subject', async () => {
    const own = await request({ user: USER_A, business: BUSINESS_A });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ userId: USER_A, businessId: BUSINESS_A, branchId: null });
    const foreign = await request({ user: USER_A, business: BUSINESS_B });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ code: 'NOT_A_MEMBER' });
    expect(mocks.membership).toHaveBeenCalledWith(USER_A, BUSINESS_B);
    expect(mocks.business).toHaveBeenCalledTimes(1);
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it('R7-03 cannot reuse an authorized tenant context for the other signed-in user', async () => {
    const one = await request({ user: USER_A, business: BUSINESS_A });
    const two = await request({ user: USER_B, business: BUSINESS_B });
    const denied = await request({ user: USER_B, business: BUSINESS_A });
    expect([one.status, two.status, denied.status]).toEqual([200, 200, 403]);
    expect(await denied.json()).toEqual({ code: 'NOT_A_MEMBER' });
    expect(mocks.permissions).toHaveBeenCalledTimes(2);
  });

  it('R7-04 denies a foreign branch selector even to an authorized business-wide user', async () => {
    const result = await request({ user: USER_A, business: BUSINESS_A, branch: BRANCH_B });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ code: 'BRANCH_ACCESS_DENIED' });
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it('R7-05 refuses cross-tenant writes before reaching the handler', async () => {
    const denied = await request({ user: USER_A, business: BUSINESS_B, method: 'POST', path: '/feedback/review' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'NOT_A_MEMBER' });
    expect(mocks.writes).not.toHaveBeenCalled();
    const own = await request({ user: USER_A, business: BUSINESS_A, method: 'POST', path: '/feedback/review' });
    expect(own.status).toBe(200);
    expect(mocks.writes).toHaveBeenCalledTimes(1);
  });

  it('R7-06 suspended staff accounts cannot pass a valid signed token', async () => {
    mocks.users.mockImplementation(async (id: string) => ({ id, status: 'suspended' }));
    const denied = await request({ user: USER_A, business: BUSINESS_A });
    expect(denied.status).toBe(401);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it('R7-07 does not allow a cross-request permissions cache to escalate B', async () => {
    mocks.membership.mockImplementation(async () => [{ branchId: null }]);
    mocks.permissions.mockImplementation(async (_userId: string, businessId: string) =>
      businessId === BUSINESS_A ? new Set(['feedback:view', 'feedback:manage']) : new Set(),
    );
    const allowed = await request({ user: USER_A, business: BUSINESS_A });
    const denied = await request({ user: USER_A, business: BUSINESS_B });
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'PERMISSION_DENIED' });
    expect(mocks.permissions).toHaveBeenNthCalledWith(1, USER_A, BUSINESS_A, undefined);
    expect(mocks.permissions).toHaveBeenNthCalledWith(2, USER_A, BUSINESS_B, undefined);
  });
});
