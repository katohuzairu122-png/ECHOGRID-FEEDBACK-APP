import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { errorHandler } from '../lib/error-handler';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  createSession: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: async () => undefined })),
}));
vi.mock('../repositories', () => ({ createRepositories: () => ({}) }));
vi.mock('./pbkdf2-worker', () => ({ createDurableObjectPbkdf2Worker: () => ({}) }));
vi.mock('../middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('./cashier-auth.service', () => ({
  CashierAuthService: class {
    login = mocks.login;
    createSession = mocks.createSession;
    refresh = mocks.refresh;
    logout = mocks.logout;
  },
}));

const { authRoutes } = await import('./auth.routes');
const { cashierScopeGuard } = await import('../middleware/cashier-scope');
const { signCashierAccessToken } = await import('./jwt');

const env = {
  JWT_ACCESS_SECRET: 'routes-secret',
  JWT_REFRESH_SECRET: 'r',
  HYPERDRIVE: { connectionString: 'x' },
} as unknown as Bindings;
const BIZ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let audit: unknown;
function app() {
  const a = new Hono<{ Bindings: Bindings }>();
  a.use('*', cashierScopeGuard);
  a.use('*', async (c, next) => {
    await next();
    audit = (c as unknown as { get: (k: string) => unknown }).get('auditMetadata');
  });
  a.route('/api/v1/auth', authRoutes);
  a.onError(errorHandler);
  return a;
}
const ctx = () =>
  ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(
    `/api/v1/auth/cashier/${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
    ctx(),
  );

const sessionResult = {
  accessToken: 'a',
  refreshToken: 'r',
  session: { businessId: BIZ, branchId: null, deviceLabel: 'Counter 1' },
  userId: 'user-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  audit = undefined;
});

describe('cashier auth routes', () => {
  it('login validates the body', async () => {
    expect((await post('login', { email: 'not-an-email', password: 'x' })).status).toBe(400);
    expect((await post('login', { email: 'a@b.test' })).status).toBe(400);
    expect(
      (await post('login', { email: 'a@b.test', password: 'x', deviceLabel: 'x'.repeat(81) }))
        .status,
    ).toBe(400);
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('login returns the session without leaking the internal user id, and audits it for the business', async () => {
    mocks.login.mockResolvedValue({ status: 'authenticated', ...sessionResult });
    const res = await post(
      'login',
      { email: 'A@B.test', password: 'x', deviceLabel: 'Counter 1' },
      { 'user-agent': 'UA' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      status: 'authenticated',
      accessToken: 'a',
      refreshToken: 'r',
    });
    expect(body.data.userId).toBeUndefined();
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.test', deviceLabel: 'Counter 1', userAgent: 'UA' }),
    );
    expect(audit).toMatchObject({ action: 'auth.cashier_login', businessId: BIZ });
  });

  it('login returns a selection step without tokens', async () => {
    mocks.login.mockResolvedValue({
      status: 'selection_required',
      ticket: 't',
      choices: [],
      userId: 'user-1',
    });
    const body = (await (await post('login', { email: 'a@b.test', password: 'x' })).json()) as {
      data: Record<string, unknown>;
    };
    expect(body.data).toEqual({ status: 'selection_required', ticket: 't', choices: [] });
    expect(audit).toBeUndefined();
  });

  it('maps service errors to their statuses', async () => {
    const { AuthError } = await import('./auth.service');
    mocks.login.mockRejectedValue(new AuthError('no', 'CASHIER_ACCESS_DENIED'));
    expect((await post('login', { email: 'a@b.test', password: 'x' })).status).toBe(403);
    mocks.login.mockRejectedValue(new AuthError('bad', 'INVALID_CREDENTIALS'));
    expect((await post('login', { email: 'a@b.test', password: 'x' })).status).toBe(401);
    mocks.refresh.mockRejectedValue(new AuthError('gone', 'CASHIER_ACCESS_REVOKED'));
    expect((await post('refresh', { refreshToken: 'x' })).status).toBe(403);
    mocks.refresh.mockRejectedValue(new AuthError('race', 'REFRESH_TOKEN_ROTATED'));
    expect((await post('refresh', { refreshToken: 'x' })).status).toBe(409);
    mocks.createSession.mockRejectedValue(new AuthError('x', 'CASHIER_SELECTION_INVALID'));
    expect((await post('session', { ticket: 't', businessId: BIZ })).status).toBe(400);
  });

  it('session finishes a selection, validates ids, and audits', async () => {
    mocks.createSession.mockResolvedValue(sessionResult);
    expect((await post('session', { ticket: 't', businessId: 'not-a-uuid' })).status).toBe(400);
    const res = await post('session', {
      ticket: 't',
      businessId: BIZ,
      branchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data.userId).toBeUndefined();
    expect(audit).toMatchObject({ action: 'auth.cashier_login', businessId: BIZ });
  });

  it('refresh returns rotated tokens with no internal ids; logout answers 204 whatever the token', async () => {
    mocks.refresh.mockResolvedValue(sessionResult);
    const r = await post('refresh', { refreshToken: 'x' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: Record<string, unknown> }).data.userId).toBeUndefined();
    mocks.logout.mockResolvedValue(null);
    expect((await post('logout', { refreshToken: 'whatever' })).status).toBe(204);
    expect(audit).toBeUndefined();
    mocks.logout.mockResolvedValue({ userId: 'user-1', businessId: BIZ });
    expect((await post('logout', { refreshToken: 'x' })).status).toBe(204);
    expect(audit).toMatchObject({ action: 'auth.cashier_logout', businessId: BIZ });
  });

  it('a cashier ACCESS token cannot call these endpoints (they are outside the bearer allow-list)', async () => {
    const token = await signCashierAccessToken('u', env.JWT_ACCESS_SECRET, {
      sessionId: SID,
      businessId: BIZ,
    });
    for (const path of ['login', 'session', 'refresh', 'logout']) {
      const res = await post(
        path,
        { email: 'a@b.test', password: 'x', refreshToken: 'x', ticket: 't', businessId: BIZ },
        { authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(403);
    }
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(AppError).toBeTruthy();
  });
});
