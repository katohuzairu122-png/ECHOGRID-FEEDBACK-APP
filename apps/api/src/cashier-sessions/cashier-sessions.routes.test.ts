import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { AuthVariables } from '../middleware/authenticate';
import type { TenantVariables } from '../middleware/tenant-context';
import type { AuditVariables } from '../middleware/audit';
import { AppError } from '../lib/errors';

/**
 * CASHIER-PWA-01 C6: listing and revoking cashier sessions. The REAL guard, authenticate, resolveTenantContext,
 * requireBusinessWideAccess, requirePermission and routes run; only database lookups are stood in for.
 */
const m = vi.hoisted(() => ({
  users: vi.fn(),
  membership: vi.fn(),
  business: vi.fn(),
  branch: vi.fn(),
  permissions: vi.fn(),
  live: vi.fn(),
  list: vi.fn(),
  revokeOne: vi.fn(),
  revokeAll: vi.fn(),
  close: vi.fn(async () => undefined),
}));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: m.close })) }));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    users: { findById: m.users },
    userBusinessRoles: { listForUserAtBusiness: m.membership },
    businesses: { findById: m.business },
    branches: { findById: m.branch },
    permissions: { findEffectiveKeys: m.permissions },
    refreshTokens: {
      isSessionLive: m.live,
      listLiveCashierSessionsForBusiness: m.list,
      revokeCashierSession: m.revokeOne,
      revokeAllCashierSessionsForBusiness: m.revokeAll,
    },
  })),
}));

const { cashierSessionRoutes } = await import('./cashier-sessions.routes');
const { cashierScopeGuard } = await import('../middleware/cashier-scope');
const { signAccessToken, signCashierAccessToken } = await import('../auth/jwt');

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };
const SECRET = 'c6-secret';
const env = { JWT_ACCESS_SECRET: SECRET, HYPERDRIVE: { connectionString: 'x' } } as unknown as Bindings;
const OWNER = '33333333-3333-4333-8333-333333333333';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const BRANCH_ADMIN = '77777777-7777-4777-8777-777777777777';
const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TARGET = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

let audit: unknown;
function app() {
  const a = new Hono<Env>();
  a.use('*', cashierScopeGuard);
  a.use('*', async (c, next) => {
    await next();
    audit = c.get('auditMetadata');
  });
  a.route('/api/v1/cashier-sessions', cashierSessionRoutes);
  a.onError((err, c) =>
    c.json(
      { code: err instanceof AppError ? err.code : 'UNEXPECTED' },
      err instanceof AppError ? err.status : 500,
    ),
  );
  return a;
}
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
async function call(method: string, path: string, token?: string, business: string | null = BIZ_A) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (business) headers.set('X-Business-Id', business);
  const res = await app().request(`/api/v1/cashier-sessions${path}`, { method, headers }, env, ctx());
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}
const web = (user: string) => signAccessToken(user, SECRET, SID);

beforeEach(() => {
  vi.clearAllMocks();
  audit = undefined;
  m.users.mockImplementation(async (id: string) => ({ id, status: 'active' }));
  m.membership.mockImplementation(async (userId: string, businessId: string) => {
    if (businessId !== BIZ_A) return [];
    return userId === BRANCH_ADMIN ? [{ branchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] : [{ branchId: null }];
  });
  m.business.mockResolvedValue({ status: 'active' });
  m.branch.mockResolvedValue({ id: 'x', businessId: BIZ_A });
  m.permissions.mockImplementation(async (userId: string) =>
    userId === MANAGER ? new Set(['loyalty:serve', 'team:view']) : new Set(['business:manage_settings']),
  );
  m.live.mockResolvedValue(true);
  m.list.mockResolvedValue([]);
  m.revokeOne.mockResolvedValue({ userId: OWNER, branchId: null });
  m.revokeAll.mockResolvedValue(2);
});

describe('C6 cashier session management', () => {
  it('lists the business\'s live cashier sessions, scoped to the caller\'s business only', async () => {
    m.list.mockResolvedValue([
      {
        sessionId: TARGET,
        userId: OWNER,
        userName: 'Pat',
        userEmail: 'pat@example.test',
        branchId: null,
        branchName: null,
        deviceLabel: 'Counter 1',
        lastActiveAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-01-01T12:00:00Z'),
      },
    ]);
    const res = await call('GET', '', await web(OWNER));
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(BIZ_A, expect.any(Number));
    expect(res.body.data[0]).toMatchObject({ sessionId: TARGET, deviceLabel: 'Counter 1', branch: null });
    // No token hash or raw token ever appears.
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it('revokes one session, pinned to the caller\'s business, and audits it', async () => {
    const res = await call('DELETE', `/${TARGET}`, await web(OWNER));
    expect(res.status).toBe(200);
    expect(m.revokeOne).toHaveBeenCalledWith(BIZ_A, TARGET);
    expect(audit).toMatchObject({ action: 'cashier_session.revoked', entityType: 'session', entityId: TARGET });
  });

  it('an unknown, other-business, web or malformed session id is the same 404 and audits nothing', async () => {
    m.revokeOne.mockResolvedValue(null);
    expect((await call('DELETE', `/${TARGET}`, await web(OWNER))).status).toBe(404);
    expect((await call('DELETE', '/not-a-uuid', await web(OWNER))).status).toBe(404);
    expect(audit).toBeUndefined();
  });

  it('revoke-all is business-scoped, cashier-only and audited with the count', async () => {
    const res = await call('POST', '/revoke-all', await web(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: 2 });
    expect(m.revokeAll).toHaveBeenCalledWith(BIZ_A);
    expect(audit).toMatchObject({ action: 'cashier_session.revoked_all', details: { revoked: 2 } });
  });

  it('a caller who is not a member of the named business is refused (no cross-business reach)', async () => {
    for (const [method, path] of [['GET', ''], ['POST', '/revoke-all'], ['DELETE', `/${TARGET}`]] as const) {
      const res = await call(method, path, await web(OWNER), BIZ_B);
      expect(res.status).toBe(403);
    }
    expect(m.list).not.toHaveBeenCalled();
    expect(m.revokeOne).not.toHaveBeenCalled();
    expect(m.revokeAll).not.toHaveBeenCalled();
  });

  it('requires the permission and business-wide access', async () => {
    expect((await call('GET', '', await web(MANAGER))).status).toBe(403);
    expect((await call('POST', '/revoke-all', await web(BRANCH_ADMIN))).status).toBe(403);
    expect(m.revokeAll).not.toHaveBeenCalled();
  });

  it('requires authentication, and a cashier token can never manage sessions', async () => {
    expect((await call('GET', '')).status).toBe(401);
    const cashier = await signCashierAccessToken(OWNER, SECRET, { sessionId: SID, businessId: BIZ_A });
    for (const [method, path] of [['GET', ''], ['POST', '/revoke-all'], ['DELETE', `/${TARGET}`]] as const) {
      const res = await call(method, path, cashier);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CASHIER_ROUTE_DENIED');
    }
    expect(m.list).not.toHaveBeenCalled();
    expect(m.revokeAll).not.toHaveBeenCalled();
  });
});
