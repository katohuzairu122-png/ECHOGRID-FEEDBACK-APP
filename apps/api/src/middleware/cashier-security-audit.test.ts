import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import type { Bindings } from '../config/env';

/**
 * SEC-CASHIER-R1 (F2): security refusals of cashier tokens reach the audit trail through the REAL application: the real
 * index.ts middleware order (audit, guard, authenticate, tenant context, permissions), the real audit recorder, and only
 * the database lookups and the audit insert stood in for. Nothing here pre-sets the audit context the way the earlier
 * unit harness did.
 */
const m = vi.hoisted(() => ({
  users: vi.fn(),
  membership: vi.fn(),
  business: vi.fn(),
  branch: vi.fn(),
  permissions: vi.fn(),
  live: vi.fn(),
  record: vi.fn(),
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
    refreshTokens: { isSessionLive: m.live },
    auditLog: { record: m.record },
  })),
}));
vi.mock('./rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { default: worker } = await import('../index');
const { signAccessToken, signCashierAccessToken } = await import('../auth/jwt');

const SECRET = 'r1-f2-secret';
const env = { JWT_ACCESS_SECRET: SECRET, HYPERDRIVE: { connectionString: 'x' } } as unknown as Bindings;
const USER = '11111111-1111-4111-8111-111111111111';
const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BR_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const now = () => Math.floor(Date.now() / 1000);
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

async function call(path: string, token?: string, headers: Record<string, string> = {}, method = 'GET') {
  const h = new Headers(headers);
  if (token) h.set('Authorization', `Bearer ${token}`);
  const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers: h }), env, ctx());
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}
const cashier = (business = BIZ_A, branch?: string) => signCashierAccessToken(USER, SECRET, { sessionId: SID, businessId: business, ...(branch ? { branchId: branch } : {}) });
const rows = () => m.record.mock.calls.map((c) => c[0] as { action: string; businessId: string | null; actorUserId: string | null; metadata: Record<string, unknown> | null });
const security = () => rows().filter((r) => r.action.startsWith('security.'));

beforeEach(() => {
  vi.clearAllMocks();
  m.record.mockResolvedValue(undefined);
  m.users.mockResolvedValue({ id: USER, status: 'active' });
  m.membership.mockResolvedValue([{ branchId: null }]);
  m.business.mockResolvedValue({ status: 'active' });
  m.branch.mockResolvedValue({ id: BR_A, businessId: BIZ_A });
  m.permissions.mockResolvedValue(new Set(['loyalty:serve', 'business:view']));
  m.live.mockResolvedValue(true);
});

describe('F2: cashier refusals through the real middleware order', () => {
  it('CASHIER_ROUTE_DENIED is recorded, attributed to the verified user and business, with the cashier marker', async () => {
    const res = await call('/api/v1/team', await cashier(BIZ_A, BR_A), { 'X-Business-Id': BIZ_A });
    expect(res).toEqual({ status: 403, code: 'CASHIER_ROUTE_DENIED' });
    expect(security()).toHaveLength(1);
    expect(security()[0]).toMatchObject({
      action: 'security.authorization_failed',
      actorUserId: USER,
      businessId: BIZ_A,
      metadata: { client: 'cashier', branchId: BR_A, outcome: 'failure', errorCode: 'CASHIER_ROUTE_DENIED' },
    });
  });

  it('CASHIER_CONTEXT_MISMATCH is attributed to the TOKEN\'s business, never the header\'s', async () => {
    const res = await call('/api/v1/businesses/me', await cashier(BIZ_A), { 'X-Business-Id': BIZ_B });
    expect(res.code).toBe('CASHIER_CONTEXT_MISMATCH');
    expect(security()[0]).toMatchObject({ businessId: BIZ_A, actorUserId: USER, metadata: { client: 'cashier', errorCode: 'CASHIER_CONTEXT_MISMATCH' } });
  });

  it('a revoked cashier session is recorded with its verified user and business', async () => {
    m.live.mockResolvedValue(false);
    const res = await call('/api/v1/businesses/me', await cashier(BIZ_A), { 'X-Business-Id': BIZ_A });
    expect(res.status).toBe(401);
    expect(security()[0]).toMatchObject({ action: 'security.authentication_failed', actorUserId: USER, businessId: BIZ_A, metadata: { client: 'cashier' } });
  });

  it('a cashier with no membership (cross-business) is recorded against the business named in the signed token', async () => {
    m.membership.mockResolvedValue([]);
    const res = await call('/api/v1/businesses/me', await cashier(BIZ_B), {});
    expect(res.code).toBe('NOT_A_MEMBER');
    expect(security()[0]).toMatchObject({ businessId: BIZ_B, actorUserId: USER, metadata: { client: 'cashier', errorCode: 'NOT_A_MEMBER' } });
  });

  it('an EXPIRED cashier token is recorded but NOT attributed to anyone', async () => {
    const expired = await sign({ sub: USER, type: 'access', client: 'cashier', bid: BIZ_A, sid: SID, iat: now() - 2000, exp: now() - 1000 }, SECRET, 'HS256');
    for (const path of ['/api/v1/businesses/me', '/api/v1/team']) {
      m.record.mockClear();
      const res = await call(path, expired, { 'X-Business-Id': BIZ_A });
      expect(res.status === 401 || res.status === 403, path).toBe(true);
      expect(security()[0]).toMatchObject({ actorUserId: null, businessId: null });
      expect(security()[0]!.metadata).not.toHaveProperty('client');
    }
  });

  it('forged and malformed tokens are never attributed, even when they claim a cashier identity', async () => {
    const forged = await sign({ sub: USER, type: 'access', client: 'cashier', bid: BIZ_A, sid: SID, iat: now(), exp: now() + 600 }, 'a-different-secret', 'HS256');
    for (const token of [forged, 'not.a.token', 'garbage']) {
      m.record.mockClear();
      await call('/api/v1/team', token, { 'X-Business-Id': BIZ_A });
      const r = security();
      if (r.length > 0) expect(r[0]).toMatchObject({ actorUserId: null, businessId: null });
      expect(r.every((x) => !('client' in (x.metadata ?? {})))).toBe(true);
    }
  });

  it('an ordinary staff refusal keeps its existing semantics (no cashier marker)', async () => {
    m.permissions.mockResolvedValue(new Set(['business:view']));
    const staff = await signAccessToken(USER, SECRET, SID);
    const res = await call('/api/v1/team', staff, { 'X-Business-Id': BIZ_A });
    expect(res.status).toBe(403);
    expect(security()[0]).toMatchObject({ action: 'security.authorization_failed', actorUserId: USER, businessId: BIZ_A });
    expect(security()[0]!.metadata).not.toHaveProperty('client');
  });

  it('a missing business context on a staff request is a plain 400, not a security event', async () => {
    const res = await call('/api/v1/team', await signAccessToken(USER, SECRET, SID), {});
    expect(res.status).toBe(400);
    expect(security()).toHaveLength(0);
  });

  it('a permitted cashier request succeeds and leaves no security event', async () => {
    const res = await call('/api/v1/businesses/me', await cashier(BIZ_A, BR_A), { 'X-Business-Id': BIZ_A });
    expect(res.status).toBe(200);
    expect(security()).toHaveLength(0);
  });

  it('a failing audit write never turns a refusal into access', async () => {
    m.record.mockRejectedValue(new Error('audit store down'));
    const denied = await call('/api/v1/team', await cashier(BIZ_A), { 'X-Business-Id': BIZ_A });
    expect(denied).toEqual({ status: 403, code: 'CASHIER_ROUTE_DENIED' });
    m.live.mockResolvedValue(false);
    expect((await call('/api/v1/businesses/me', await cashier(BIZ_A), { 'X-Business-Id': BIZ_A })).status).toBe(401);
  });

  it('the recorded refusal carries no token material', async () => {
    const token = await cashier(BIZ_A);
    await call('/api/v1/team', token, { 'X-Business-Id': BIZ_A });
    expect(JSON.stringify(rows())).not.toContain(token.split('.')[2]!);
  });
});
