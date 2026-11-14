import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { AppError } from '../lib/errors';

/**
 * CASHIER-PWA-01 C2 security matrix. The REAL guard, authenticate, resolveTenantContext and requirePermission run;
 * only the database lookups are stood in for. Every negative case also asserts that no handler ran.
 */
const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  membership: vi.fn(),
  business: vi.fn(),
  branch: vi.fn(),
  permissions: vi.fn(),
  live: vi.fn(),
  reached: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: mocks.close })) }));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    users: { findById: mocks.users },
    userBusinessRoles: { listForUserAtBusiness: mocks.membership },
    businesses: { findById: mocks.business },
    branches: { findById: mocks.branch },
    permissions: { findEffectiveKeys: mocks.permissions },
    refreshTokens: { isSessionLive: mocks.live },
  })),
}));
vi.mock('./rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
  cashierAuthRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('./audit', () => ({
  auditTrail: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { cashierScopeGuard } = await import('./cashier-scope');
const { authenticate } = await import('./authenticate');
const { resolveTenantContext } = await import('./tenant-context');
const { requirePermission } = await import('./require-permission');
const { signAccessToken, signCashierAccessToken, signImpersonationToken } =
  await import('../auth/jwt');
const { signCustomerAccessToken } = await import('../customer-auth/customer-jwt');
const { default: worker } = await import('../index');

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };
const SECRET = 'cashier-c2-matrix-secret';
const env = {
  JWT_ACCESS_SECRET: SECRET,
  CUSTOMER_JWT_SECRET: 'customer-matrix-secret',
  HYPERDRIVE: { connectionString: 'x' },
} as unknown as Bindings;
const CASHIER = '11111111-1111-4111-8111-111111111111';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const MANAGER_NO_SERVE = '44444444-4444-4444-8444-444444444444';
const BRANCH_STAFF = '55555555-5555-4555-8555-555555555555';
const ADMIN = '66666666-6666-4666-8666-666666666666';
const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRANCH_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BRANCH_A2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const BRANCH_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function stubApp() {
  const a = new Hono<Env>();
  a.use('*', cashierScopeGuard, authenticate, resolveTenantContext);
  const ok = (c: {
    json: (b: unknown) => Response;
    get: (k: 'businessId' | 'branchId' | 'userId') => unknown;
  }) => {
    mocks.reached();
    return c.json({
      businessId: c.get('businessId'),
      branchId: c.get('branchId') ?? null,
      userId: c.get('userId'),
    });
  };
  a.post('/api/v1/loyalty/actions/lookup-customer', requirePermission('loyalty:serve'), ok);
  a.post('/api/v1/loyalty/accounts/:id/purchase', requirePermission('loyalty:serve'), ok);
  a.get('/api/v1/loyalty/redemptions/:code', requirePermission('loyalty:serve'), ok);
  a.get('/api/v1/businesses/me', ok);
  a.get('/api/v1/billing/subscription', requirePermission('billing:view'), ok);
  a.get('/api/v1/team', requirePermission('team:view'), ok);
  a.get('/api/v1/loyalty/rewards', requirePermission('loyalty:view'), ok);
  a.post('/api/v1/loyalty/rewards', requirePermission('rewards:manage'), ok);
  a.get('/api/v1/platform/businesses', ok);
  a.delete('/api/v1/businesses/me', ok);
  a.onError((err, c) =>
    c.json(
      { code: err instanceof AppError ? err.code : 'UNEXPECTED' },
      err instanceof AppError ? err.status : 500,
    ),
  );
  return a;
}

const ctx = () =>
  ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

async function call(opts: {
  method?: string;
  path: string;
  token?: string;
  business?: string;
  branch?: string;
}) {
  const headers = new Headers();
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  if (opts.business) headers.set('X-Business-Id', opts.business);
  if (opts.branch) headers.set('X-Branch-Id', opts.branch);
  const res = await stubApp().request(
    opts.path,
    { method: opts.method ?? 'GET', headers },
    env,
    ctx(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const cashierToken = (user: string, business: string, branch?: string) =>
  signCashierAccessToken(user, SECRET, {
    sessionId: SID,
    businessId: business,
    ...(branch ? { branchId: branch } : {}),
  });
const adminToken = (user: string) => signAccessToken(user, SECRET, SID);
const now = () => Math.floor(Date.now() / 1000);

const SERVE = ['loyalty:serve', 'business:view', 'branches:view'];
const MANAGEMENT = [...SERVE, 'billing:view', 'team:view', 'loyalty:view', 'rewards:manage'];

beforeEach(() => {
  mocks.live.mockReset().mockResolvedValue(true);
  vi.clearAllMocks();
  mocks.users.mockImplementation(async (id: string) => ({
    id,
    status: id === 'inactive' ? 'suspended' : 'active',
  }));
  // Memberships: cashier, manager, owner, manager-without-serve are business-wide in A; branch staff only at BRANCH_A in A.
  mocks.membership.mockImplementation(async (userId: string, businessId: string) => {
    if (businessId !== BIZ_A) return [];
    if (userId === BRANCH_STAFF) return [{ branchId: BRANCH_A }];
    return [CASHIER, MANAGER, OWNER, MANAGER_NO_SERVE, ADMIN].includes(userId)
      ? [{ branchId: null }]
      : [];
  });
  mocks.business.mockResolvedValue({ status: 'active' });
  mocks.branch.mockImplementation(async (id: string, businessId: string) =>
    (id === BRANCH_A || id === BRANCH_A2) && businessId === BIZ_A ? { id, businessId } : undefined,
  );
  mocks.permissions.mockImplementation(async (userId: string) => {
    if (userId === CASHIER || userId === BRANCH_STAFF) return new Set(SERVE);
    if (userId === MANAGER_NO_SERVE)
      return new Set(MANAGEMENT.filter((p) => p !== 'loyalty:serve'));
    if (userId === MANAGER || userId === OWNER || userId === ADMIN) return new Set(MANAGEMENT);
    return new Set();
  });
});

describe('1-2. a cashier token is refused on administrative and platform routes', () => {
  it.each([
    ['GET', '/api/v1/billing/subscription'],
    ['GET', '/api/v1/team'],
    ['GET', '/api/v1/loyalty/rewards'],
    ['POST', '/api/v1/loyalty/rewards'],
    ['GET', '/api/v1/platform/businesses'],
  ])('%s %s -> 403 CASHIER_ROUTE_DENIED, no handler, no database work', async (method, path) => {
    // Even an owner's cashier token (who holds every permission) is refused: the scope narrows, whatever the role.
    const res = await call({
      method,
      path,
      token: await cashierToken(OWNER, BIZ_A),
      business: BIZ_A,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CASHIER_ROUTE_DENIED');
    expect(mocks.reached).not.toHaveBeenCalled();
    expect(mocks.users).not.toHaveBeenCalled();
    expect(mocks.membership).not.toHaveBeenCalled();
  });
});

describe('5-6. unlisted endpoints and unsupported methods', () => {
  it('refuses an unlisted endpoint, and a non-listed method on a listed path', async () => {
    const token = await cashierToken(CASHIER, BIZ_A);
    expect(
      (await call({ path: '/api/v1/loyalty/rewards', token, business: BIZ_A })).body.code,
    ).toBe('CASHIER_ROUTE_DENIED');
    expect(
      (await call({ method: 'DELETE', path: '/api/v1/businesses/me', token, business: BIZ_A })).body
        .code,
    ).toBe('CASHIER_ROUTE_DENIED');
    expect(
      (
        await call({
          method: 'GET',
          path: '/api/v1/loyalty/actions/lookup-customer',
          token,
          business: BIZ_A,
        })
      ).body.code,
    ).toBe('CASHIER_ROUTE_DENIED');
    expect((await call({ path: '/api/v1/businesses/me/', token, business: BIZ_A })).body.code).toBe(
      'CASHIER_ROUTE_DENIED',
    );
    expect(mocks.reached).not.toHaveBeenCalled();
  });
});

describe('listed counter routes still obey the existing permission and tenant model', () => {
  const route = { method: 'POST', path: '/api/v1/loyalty/actions/lookup-customer' };

  it.each([
    ['cashier', CASHIER],
    ['manager', MANAGER],
    ['owner', OWNER],
  ])('%s with loyalty:serve is served through a cashier token', async (_role, user) => {
    const res = await call({ ...route, token: await cashierToken(user, BIZ_A), business: BIZ_A });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ businessId: BIZ_A, branchId: null, userId: user });
  });

  it('a manager WITHOUT loyalty:serve gains nothing from a cashier token (existing permission model applies)', async () => {
    const res = await call({
      ...route,
      token: await cashierToken(MANAGER_NO_SERVE, BIZ_A),
      business: BIZ_A,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('CASHIER_ROUTE_DENIED');
    expect(mocks.reached).not.toHaveBeenCalled();
  });

  it('the business may be taken from the signed token alone; the header is optional', async () => {
    const res = await call({ ...route, token: await cashierToken(CASHIER, BIZ_A) });
    expect(res.status).toBe(200);
    expect(res.body.businessId).toBe(BIZ_A);
  });

  it('an ordinary admin or manager token keeps working exactly as before on listed and unlisted routes', async () => {
    expect(
      (
        await call({
          path: '/api/v1/billing/subscription',
          token: await adminToken(MANAGER),
          business: BIZ_A,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call({ ...route, token: await adminToken(CASHIER), business: BIZ_A })).status,
    ).toBe(200);
    expect(
      (
        await call({
          path: '/api/v1/billing/subscription',
          token: await adminToken(CASHIER),
          business: BIZ_A,
        })
      ).status,
    ).toBe(403);
  });
});

describe('3-4. business and branch binding', () => {
  const route = { method: 'POST', path: '/api/v1/loyalty/actions/lookup-customer' };

  it('refuses a header naming another business than the one the token is bound to', async () => {
    const res = await call({
      ...route,
      token: await cashierToken(CASHIER, BIZ_A),
      business: BIZ_B,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CASHIER_CONTEXT_MISMATCH');
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.reached).not.toHaveBeenCalled();
  });

  it('verifies the bound business against the staff membership (a token cannot invent access)', async () => {
    const res = await call({
      ...route,
      token: await cashierToken(CASHIER, BIZ_B),
      business: BIZ_B,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_MEMBER');
    expect(mocks.reached).not.toHaveBeenCalled();
  });

  it('refuses a branch header that differs from the bound branch, or any branch header on a business-wide binding', async () => {
    const bound = await cashierToken(CASHIER, BIZ_A, BRANCH_A);
    expect(
      (await call({ ...route, token: bound, business: BIZ_A, branch: BRANCH_A2 })).body.code,
    ).toBe('CASHIER_CONTEXT_MISMATCH');
    expect(
      (await call({ ...route, token: bound, business: BIZ_A, branch: BRANCH_B })).body.code,
    ).toBe('CASHIER_CONTEXT_MISMATCH');
    const wide = await cashierToken(CASHIER, BIZ_A);
    expect(
      (await call({ ...route, token: wide, business: BIZ_A, branch: BRANCH_A })).body.code,
    ).toBe('CASHIER_CONTEXT_MISMATCH');
    expect(mocks.reached).not.toHaveBeenCalled();
  });

  it('uses the bound branch without a header, and still validates it (branch staff, wrong or foreign branch)', async () => {
    const ok = await call({ ...route, token: await cashierToken(BRANCH_STAFF, BIZ_A, BRANCH_A) });
    expect(ok.status).toBe(200);
    expect(ok.body.branchId).toBe(BRANCH_A);
    // Branch staff bound to a branch they hold no grant for.
    const other = await call({
      ...route,
      token: await cashierToken(BRANCH_STAFF, BIZ_A, BRANCH_A2),
    });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('BRANCH_ACCESS_DENIED');
    // A branch that belongs to another business.
    const foreign = await call({ ...route, token: await cashierToken(CASHIER, BIZ_A, BRANCH_B) });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('BRANCH_ACCESS_DENIED');
    // Branch-scoped staff with a business-wide binding: a branch is required.
    const noBranch = await call({ ...route, token: await cashierToken(BRANCH_STAFF, BIZ_A) });
    expect(noBranch.body.code).toBe('BRANCH_CONTEXT_REQUIRED');
  });

  it('C6: a revoked or expired cashier session loses access on the very next request', async () => {
    mocks.live.mockResolvedValueOnce(false);
    const res = await call({ ...route, token: await cashierToken(CASHIER, BIZ_A) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(mocks.reached).not.toHaveBeenCalled();
    expect(mocks.live).toHaveBeenCalledWith(CASHIER, expect.any(String), expect.any(Number));
  });

  it('refuses inactive users, removed memberships and suspended businesses', async () => {
    expect((await call({ ...route, token: await cashierToken('inactive', BIZ_A) })).status).toBe(
      401,
    );
    mocks.membership.mockResolvedValueOnce([]);
    expect((await call({ ...route, token: await cashierToken(CASHIER, BIZ_A) })).body.code).toBe(
      'NOT_A_MEMBER',
    );
    mocks.business.mockResolvedValueOnce({ status: 'suspended' });
    expect((await call({ ...route, token: await cashierToken(CASHIER, BIZ_A) })).body.code).toBe(
      'BUSINESS_NOT_ACTIVE',
    );
    expect(mocks.reached).not.toHaveBeenCalled();
  });
});

describe('7-9. impersonated, invalid and mis-scoped tokens', () => {
  const route = { method: 'POST', path: '/api/v1/loyalty/actions/lookup-customer' };
  const forge = (extra: Record<string, unknown>, secret = SECRET) =>
    sign({ sub: CASHIER, type: 'access', iat: now(), exp: now() + 600, ...extra }, secret, 'HS256');

  it('refuses a cashier token that is also an impersonation token', async () => {
    const res = await call({
      ...route,
      token: await forge({ client: 'cashier', bid: BIZ_A, sid: SID, impersonatedBy: ADMIN }),
      business: BIZ_A,
    });
    expect(res.status).toBe(401);
    expect(mocks.reached).not.toHaveBeenCalled();
    // A genuine impersonation token is an ordinary (unscoped) token: it carries no cashier scope, so the guard
    // does not apply to it, and it is not a cashier token.
    const { token } = await signImpersonationToken(CASHIER, ADMIN, SECRET);
    expect(
      (await call({ path: '/api/v1/billing/subscription', token, business: BIZ_A })).body.code,
    ).not.toBe('CASHIER_ROUTE_DENIED');
  });

  it('refuses expired, wrongly signed and malformed cashier tokens', async () => {
    const expired = await sign(
      {
        sub: CASHIER,
        type: 'access',
        client: 'cashier',
        bid: BIZ_A,
        sid: SID,
        iat: now() - 2000,
        exp: now() - 1000,
      },
      SECRET,
      'HS256',
    );
    const wrong = await signCashierAccessToken(CASHIER, 'another-secret', {
      sessionId: SID,
      businessId: BIZ_A,
    });
    for (const token of [expired, wrong, 'garbage', 'a.b.c']) {
      const res = await call({ ...route, token, business: BIZ_A });
      expect([401, 403]).toContain(res.status);
      expect(mocks.reached).not.toHaveBeenCalled();
    }
    expect((await call({ ...route, token: expired, business: BIZ_A })).status).toBe(401);
    expect((await call({ ...route, token: wrong, business: BIZ_A })).status).toBe(401);
  });

  it('refuses an ordinary token carrying binding claims, and a cashier claim without a session or with a bad binding', async () => {
    // Binding claims without a client count as a scope claim, so the guard refuses them before any verification.
    expect(
      (await call({ ...route, token: await forge({ bid: BIZ_A, sid: SID }), business: BIZ_A }))
        .status,
    ).toBe(403);
    expect(
      (
        await call({
          ...route,
          token: await forge({ client: 'cashier', bid: BIZ_A }),
          business: BIZ_A,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call({
          ...route,
          token: await forge({ client: 'cashier', bid: 'nope', sid: SID }),
          business: BIZ_A,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call({
          ...route,
          token: await forge({ client: 'kiosk', bid: BIZ_A, sid: SID }),
          business: BIZ_A,
        })
      ).body.code,
    ).toBe('CASHIER_ROUTE_DENIED');
    expect(mocks.reached).not.toHaveBeenCalled();
  });
});

describe('the guard in front of the whole application (every bearer surface, before any handler)', () => {
  const fetchApp = async (path: string, token: string, method = 'GET', withBusiness = true) =>
    worker.fetch(
      new Request(`https://api.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(withBusiness ? { 'X-Business-Id': BIZ_A } : {}),
        },
      }),
      env,
      ctx(),
    );

  it.each([
    ['GET', '/api/v1/billing/subscription'],
    ['GET', '/api/v1/team'],
    ['GET', '/api/v1/platform/businesses'],
    ['GET', '/api/v1/platform/customers'],
    ['POST', '/api/v1/platform/customers/x/sanctions'],
    ['GET', '/api/v1/internal/stripe-read/anything'],
    ['GET', '/api/v1/settlements'],
  ])('%s %s -> 403 CASHIER_ROUTE_DENIED with no database access', async (method, path) => {
    const res = await fetchApp(path, await cashierToken(OWNER, BIZ_A), method);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: 'CASHIER_ROUTE_DENIED' },
    });
    expect(mocks.users).not.toHaveBeenCalled();
  });

  it('does not change a customer token or an ordinary staff token reaching the real application', async () => {
    const customer = await signCustomerAccessToken(CASHIER, env.CUSTOMER_JWT_SECRET);
    const res = await fetchApp('/api/v1/team', customer);
    expect(res.status).toBe(401); // a customer token is not a staff token; refused by staff authentication, not by the cashier guard
    // An ordinary staff token passes authentication and is stopped later, by the tenant check (no business header),
    // never by the cashier guard.
    const staff = await fetchApp('/api/v1/team', await adminToken(OWNER), 'GET', false);
    expect(staff.status).toBe(400);
    expect(await staff.text()).toContain('MISSING_BUSINESS_CONTEXT');
  });
});

describe('C7/C8: the real application mounts the cashier management routes behind the same guard', () => {
  const real = (path: string, token: string, method = 'GET') =>
    worker.fetch(
      new Request(`https://api.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'X-Business-Id': BIZ_A },
      }),
      env,
      ctx(),
    );

  it.each([
    ['GET', '/api/v1/cashier-sessions'],
    ['POST', '/api/v1/cashier-sessions/revoke-all'],
    ['DELETE', '/api/v1/cashier-sessions/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
    ['GET', '/api/v1/cashier-activity'],
  ])('a cashier token, even the owner\'s, is refused on %s %s before any handler or database work', async (method, path) => {
    const res = await real(path, await cashierToken(OWNER, BIZ_A), method);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CASHIER_ROUTE_DENIED');
    expect(mocks.membership).not.toHaveBeenCalled();
  });

  it('an allowed route refuses a cashier token whose session was revoked, through the real application', async () => {
    mocks.live.mockResolvedValue(false);
    const res = await real('/api/v1/businesses/me', await cashierToken(CASHIER, BIZ_A));
    expect(res.status).toBe(401);
    expect(mocks.membership).not.toHaveBeenCalled();
  });
});
