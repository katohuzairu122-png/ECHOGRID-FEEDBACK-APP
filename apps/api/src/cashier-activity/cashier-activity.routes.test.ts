import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { AuthVariables } from '../middleware/authenticate';
import type { TenantVariables } from '../middleware/tenant-context';
import { AppError } from '../lib/errors';

const m = vi.hoisted(() => ({
  users: vi.fn(),
  grants: vi.fn(),
  business: vi.fn(),
  branch: vi.fn(),
  perms: vi.fn(),
  live: vi.fn(),
  list: vi.fn(),
  branches: vi.fn(),
  close: vi.fn(async () => undefined),
}));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: m.close })) }));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    users: { findById: m.users },
    userBusinessRoles: { listForUserAtBusiness: m.grants },
    businesses: { findById: m.business },
    branches: { findById: m.branch, listByBusiness: m.branches },
    permissions: { findEffectiveKeys: m.perms },
    refreshTokens: { isSessionLive: m.live },
    auditLog: { listCashierActivity: m.list },
  })),
}));

const { cashierActivityRoutes, encodeCursor, decodeCursor } = await import('./cashier-activity.routes');
const { cashierScopeGuard } = await import('../middleware/cashier-scope');
const { signAccessToken, signCashierAccessToken } = await import('../auth/jwt');

const SECRET = 'c7-secret';
const env = { JWT_ACCESS_SECRET: SECRET, HYPERDRIVE: { connectionString: 'x' } } as unknown as Bindings;
const OWNER = '33333333-3333-4333-8333-333333333333';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const BRANCH_MGR = '77777777-7777-4777-8777-777777777777';
const COUNTER = '11111111-1111-4111-8111-111111111111';
const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BR1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const BR2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ROW = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables };
function app() {
  const a = new Hono<Env>();
  a.use('*', cashierScopeGuard);
  a.route('/api/v1/cashier-activity', cashierActivityRoutes);
  a.onError((err, c) => c.json({ code: err instanceof AppError ? err.code : 'UNEXPECTED' }, err instanceof AppError ? err.status : 500));
  return a;
}
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
async function get(query: string, token?: string, business: string | null = BIZ_A, branch?: string) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (business) headers.set('X-Business-Id', business);
  if (branch) headers.set('X-Branch-Id', branch);
  const res = await app().request(`/api/v1/cashier-activity${query}`, { headers }, env, ctx());
  return { status: res.status, body: (await res.json()) as { code?: string; data?: { items: Record<string, unknown>[]; nextCursor: string | null } } };
}
const web = (u: string) => signAccessToken(u, SECRET, SID);

const row = (over: Record<string, unknown> = {}) => ({
  id: ROW,
  businessId: BIZ_A,
  actorUserId: COUNTER,
  actorFullName: 'Pat',
  action: 'loyalty.purchase_recorded',
  entityType: 'loyalty_account',
  entityId: 'acct-secret',
  metadata: { client: 'cashier', branchId: BR1, outcome: 'success', phoneHash: 'x', ip: '1.2.3.4' },
  ipAddress: '1.2.3.4',
  userAgent: 'UA',
  createdAt: new Date('2026-01-01T10:00:00.123Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.users.mockImplementation(async (id: string) => ({ id, status: 'active' }));
  m.grants.mockImplementation(async (u: string, b: string) => {
    if (b !== BIZ_A) return [];
    if (u === BRANCH_MGR) return [{ branchId: BR1 }, { branchId: BR2 }];
    return [{ branchId: null }];
  });
  m.business.mockResolvedValue({ status: 'active' });
  m.branch.mockResolvedValue({ id: 'x', businessId: BIZ_A });
  m.perms.mockImplementation(async (u: string) =>
    u === OWNER ? new Set(['audit:view', 'loyalty:accounts:view', 'loyalty:serve'])
    : u === MANAGER || u === BRANCH_MGR ? new Set(['loyalty:accounts:view', 'loyalty:serve'])
    : new Set(['loyalty:serve']),
  );
  m.live.mockResolvedValue(true);
  m.list.mockResolvedValue([row()]);
  m.branches.mockResolvedValue([{ id: BR1, name: 'Main' }]);
});

describe('C7 cashier activity history', () => {
  it('Owner reads business-wide history, scoped to their business, with a correlation id and no sensitive fields', async () => {
    const res = await get('', await web(OWNER));
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ_A, branchIds: null }));
    const item = res.body.data!.items[0]!;
    expect(item).toMatchObject({ correlationId: ROW, businessId: BIZ_A, branchId: BR1, branchName: 'Main', categories: ['points_issued'], outcome: 'success', reference: null });
    expect(item.actor).toEqual({ id: COUNTER, name: 'Pat' });
    const text = JSON.stringify(res.body);
    for (const secret of ['acct-secret', '1.2.3.4', 'phoneHash', 'UA']) expect(text).not.toContain(secret);
  });

  it('a manager with branch grants sees only those branches, and cannot request another', async () => {
    const res = await get('', await web(BRANCH_MGR), BIZ_A, BR1);
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ branchIds: [BR1, BR2] }));
    m.list.mockClear();
    const other = await get(`?branchId=${'d'.repeat(8)}-dddd-4ddd-8ddd-dddddddddddd`, await web(BRANCH_MGR), BIZ_A, BR1);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('BRANCH_ACCESS_DENIED');
    expect(m.list).not.toHaveBeenCalled();
  });

  it('a business-wide manager reads all authorized branches; a counter-only role is refused (no own-activity permission exists)', async () => {
    expect((await get('', await web(MANAGER))).status).toBe(200);
    const counter = await get('', await web(COUNTER));
    expect(counter.status).toBe(403);
    expect(counter.body.code).toBe('PERMISSION_DENIED');
    expect(m.list).toHaveBeenCalledTimes(1);
  });

  it('cross-business access is refused, whatever the filters', async () => {
    const res = await get(`?branchId=${BR1}`, await web(OWNER), BIZ_B);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_MEMBER');
    expect(m.list).not.toHaveBeenCalled();
  });

  it('refuses suspended businesses, inactive users and unauthenticated callers', async () => {
    m.business.mockResolvedValueOnce({ status: 'suspended' });
    expect((await get('', await web(OWNER))).status).toBe(403);
    m.users.mockResolvedValueOnce({ id: OWNER, status: 'suspended' });
    expect((await get('', await web(OWNER))).status).toBe(401);
    expect((await get('')).status).toBe(401);
    expect(m.list).not.toHaveBeenCalled();
  });

  it('a cashier token, even an owner\'s, can never read history', async () => {
    const token = await signCashierAccessToken(OWNER, SECRET, { sessionId: SID, businessId: BIZ_A });
    const res = await get('', token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CASHIER_ROUTE_DENIED');
    expect(m.list).not.toHaveBeenCalled();
  });

  it('validates filters, limit and cursor', async () => {
    const t = await web(OWNER);
    for (const q of ['?category=nope', '?limit=0', '?limit=101', '?limit=x', '?branchId=nope', '?actorUserId=nope', '?from=nope', '?cursor=nope'])
      expect((await get(q, t)).status, q).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
    expect((await get('?category=redemption_failure&limit=100', t)).status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, selection: expect.any(Array) }));
  });

  it('paginates with a keyset cursor: one extra row signals another page', async () => {
    m.list.mockResolvedValue([row({ id: ROW }), row({ id: 'eeeeeeee-0000-4000-8000-000000000001', createdAt: new Date('2026-01-01T09:00:00.000Z') })]);
    const res = await get('?limit=1', await web(OWNER));
    expect(res.body.data!.items).toHaveLength(1);
    const cursor = res.body.data!.nextCursor!;
    expect(decodeCursor(cursor)).toEqual({ createdAt: new Date('2026-01-01T10:00:00.123Z'), id: ROW });
    m.list.mockResolvedValue([]);
    const next = await get(`?limit=1&cursor=${cursor}`, await web(OWNER));
    expect(next.body.data!.nextCursor).toBeNull();
    expect(m.list).toHaveBeenLastCalledWith(expect.objectContaining({ before: { createdAt: new Date('2026-01-01T10:00:00.123Z'), id: ROW } }));
    expect(encodeCursor(new Date(0), ROW)).not.toContain('=');
  });

  it('drops rows that are not cashier activity even if the store returned them', async () => {
    m.list.mockResolvedValue([row({ action: 'team.invite', metadata: null })]);
    expect((await get('', await web(OWNER))).body.data!.items).toEqual([]);
  });
});
