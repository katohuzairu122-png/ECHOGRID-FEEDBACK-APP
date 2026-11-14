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
const ADMIN = '88888888-8888-4888-8888-888888888888';
const MIX_MA_SB = '99999999-9999-4999-8999-999999999991'; // Manager at A, Staff at B
const MIX_MA_MB = '99999999-9999-4999-8999-999999999992'; // Manager at A and at B
const MIX_SA_MB = '99999999-9999-4999-8999-999999999993'; // Staff at A, Manager at B
const MIX_WIDE_STAFF_MA = '99999999-9999-4999-8999-999999999994'; // business-wide Staff, Manager at A
const COUNTER = '11111111-1111-4111-8111-111111111111';
const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BR1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const BR2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const ROLE = {
  owner: ['audit:view', 'loyalty:accounts:view', 'loyalty:serve'],
  manager: ['loyalty:accounts:view', 'loyalty:serve'],
  staff: ['loyalty:serve'],
} as const;
type Grant = { branchId: string | null; role: keyof typeof ROLE };
const GRANTS: Record<string, Grant[]> = {
  [OWNER]: [{ branchId: null, role: 'owner' }],
  [ADMIN]: [{ branchId: null, role: 'owner' }],
  [MANAGER]: [{ branchId: null, role: 'manager' }],
  [COUNTER]: [{ branchId: null, role: 'staff' }],
  [BRANCH_MGR]: [{ branchId: BR1, role: 'manager' }, { branchId: BR2, role: 'manager' }],
  [MIX_MA_SB]: [{ branchId: BR1, role: 'manager' }, { branchId: BR2, role: 'staff' }],
  [MIX_MA_MB]: [{ branchId: BR1, role: 'manager' }, { branchId: BR2, role: 'manager' }],
  [MIX_SA_MB]: [{ branchId: BR1, role: 'staff' }, { branchId: BR2, role: 'manager' }],
  [MIX_WIDE_STAFF_MA]: [{ branchId: null, role: 'staff' }, { branchId: BR1, role: 'manager' }],
};
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
  m.grants.mockImplementation(async (u: string, b: string) => (b === BIZ_A ? (GRANTS[u] ?? []).map((g) => ({ branchId: g.branchId })) : []));
  m.business.mockResolvedValue({ status: 'active' });
  m.branch.mockResolvedValue({ id: 'x', businessId: BIZ_A });
  // Effective permissions are computed like the real repository: business-wide grants plus grants at the asked branch.
  m.perms.mockImplementation(async (u: string, b: string, branch?: string) => {
    const keys = new Set<string>();
    if (b !== BIZ_A) return keys;
    for (const g of GRANTS[u] ?? []) if (g.branchId === null || g.branchId === branch) for (const k of ROLE[g.role]) keys.add(k);
    return keys;
  });
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

const BR3 = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
const scopeOf = () => m.list.mock.calls.at(-1)![0] as { branchIds: string[] | null };

describe('SEC-CASHIER-R1 F1: visibility is decided per branch from effective permissions', () => {
  it('Manager at A / Staff at B: sees only A, and cannot reach B by filter or by borrowing the A header', async () => {
    const t = await web(MIX_MA_SB);
    expect((await get('', t, BIZ_A, BR1)).status).toBe(200);
    expect(scopeOf().branchIds).toEqual([BR1]);
    m.list.mockClear();
    const filter = await get(`?branchId=${BR2}`, t, BIZ_A, BR1);
    expect(filter.status).toBe(403);
    expect(filter.body.code).toBe('BRANCH_ACCESS_DENIED');
    // Acting as B (where the user is only Staff) must not inherit the visibility granted at A.
    const acting = await get('', t, BIZ_A, BR2);
    expect(acting.status).toBe(403);
    expect(acting.body.code).toBe('BRANCH_ACCESS_DENIED');
    expect(m.list).not.toHaveBeenCalled();
  });

  it('Manager at A / Manager at B: sees both', async () => {
    expect((await get('', await web(MIX_MA_MB), BIZ_A, BR1)).status).toBe(200);
    expect(scopeOf().branchIds?.sort()).toEqual([BR1, BR2].sort());
  });

  it('Staff at A / Manager at B: only B; the A header is refused', async () => {
    const t = await web(MIX_SA_MB);
    const a = await get('', t, BIZ_A, BR1);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('BRANCH_ACCESS_DENIED');
    expect(m.list).not.toHaveBeenCalled();
    expect((await get('', t, BIZ_A, BR2)).status).toBe(200);
    expect(scopeOf().branchIds).toEqual([BR2]);
  });

  it('business-wide Staff who is Manager at A sees A only, with or without a branch header', async () => {
    const t = await web(MIX_WIDE_STAFF_MA);
    expect((await get('', t, BIZ_A)).status).toBe(200);
    expect(scopeOf().branchIds).toEqual([BR1]);
    expect((await get('', t, BIZ_A, BR1)).status).toBe(200);
    expect((await get(`?branchId=${BR2}`, t, BIZ_A)).status).toBe(403);
  });

  it('business-wide Owner and Admin see every branch (no branch restriction)', async () => {
    for (const user of [OWNER, ADMIN]) {
      m.list.mockClear();
      expect((await get('', await web(user))).status).toBe(200);
      expect(scopeOf().branchIds).toBeNull();
    }
  });

  it('a business-wide Manager sees every branch of the business; a business-wide Staff sees none', async () => {
    expect((await get('', await web(MANAGER))).status).toBe(200);
    expect(scopeOf().branchIds).toBeNull();
    m.list.mockClear();
    expect((await get('', await web(COUNTER))).status).toBe(403);
    expect(m.list).not.toHaveBeenCalled();
  });

  it('cross-business access is refused', async () => {
    for (const user of [OWNER, MIX_MA_MB]) expect((await get('', await web(user), BIZ_B)).body.code).toBe('NOT_A_MEMBER');
    expect(m.list).not.toHaveBeenCalled();
  });

  it('missing or invalid branch context is refused before any history is read', async () => {
    const t = await web(MIX_MA_MB);
    expect((await get('', t, BIZ_A)).body.code).toBe('BRANCH_CONTEXT_REQUIRED'); // branch-scoped caller named no branch
    m.branch.mockImplementation(async (id: string) => (id === BR3 ? undefined : { id, businessId: BIZ_A }));
    expect((await get('', t, BIZ_A, BR3)).status).toBe(403); // a branch that does not exist for this business
    expect((await get('?branchId=not-a-uuid', t, BIZ_A, BR1)).status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });

  it('keyset pagination keeps the same branch restriction on every page', async () => {
    const t = await web(MIX_MA_SB);
    m.list.mockResolvedValue([row({ id: ROW }), row({ id: 'eeeeeeee-0000-4000-8000-000000000001', createdAt: new Date('2026-01-01T09:00:00.000Z') })]);
    const first = await get('?limit=1', t, BIZ_A, BR1);
    const cursor = first.body.data!.nextCursor!;
    m.list.mockResolvedValue([]);
    await get(`?limit=1&cursor=${cursor}`, t, BIZ_A, BR1);
    expect(m.list).toHaveBeenLastCalledWith(expect.objectContaining({ branchIds: [BR1], before: expect.objectContaining({ id: ROW }) }));
    expect(scopeOf().branchIds).toEqual([BR1]);
  });

  it('a hand-made cursor only chooses a position: it cannot widen or change the branch scope', async () => {
    const t = await web(MIX_MA_SB);
    const forged = btoa(`2026-01-01T00:00:00.000Z|${ROW}|${BR2}`).replace(/=+$/, ''); // extra field naming branch B
    const res = await get(`?cursor=${forged}`, t, BIZ_A, BR1);
    expect(res.status).toBe(200); // the decoder ignores the extra field: only the position is taken
    expect(scopeOf().branchIds).toEqual([BR1]);
    m.list.mockClear();
    expect((await get('?cursor=%00%00', t, BIZ_A, BR1)).status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });
});
