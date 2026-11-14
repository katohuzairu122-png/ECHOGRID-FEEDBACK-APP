import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ access: vi.fn(), refresh: vi.fn(), ctx: vi.fn(), set: vi.fn(), clear: vi.fn() }));
vi.mock('./session', () => ({
  getCashierAccessToken: m.access,
  getCashierRefreshToken: m.refresh,
  getCashierContext: m.ctx,
  setCashierSession: m.set,
  clearCashierSession: m.clear,
}));
vi.mock('../session', () => ({ getAccessToken: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));

import { cashierApiFetch, ensureCashierAccess, refreshCashierSession } from './auth-api';

const ok = (data: unknown) => Response.json({ success: true, data });
const fail = (status: number, code: string) => Response.json({ success: false, error: { code, message: code } }, { status });

beforeEach(() => {
  vi.clearAllMocks();
  m.refresh.mockResolvedValue('REFRESH');
});

describe('cashier refresh', () => {
  it('rotates through the cashier refresh endpoint and persists the new pair', async () => {
    const next = { accessToken: 'a2', refreshToken: 'r2', session: { businessId: 'b', branchId: null, deviceLabel: null } };
    const f = vi.fn(async () => ok(next));
    vi.stubGlobal('fetch', f);
    expect(await refreshCashierSession()).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/auth\/cashier\/refresh$/);
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'REFRESH' });
    expect(m.set).toHaveBeenCalledWith(next);
  });

  it('a revoked, expired or replayed session cannot refresh: cookies are cleared, nothing is stored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(401, 'INVALID_REFRESH_TOKEN')));
    expect(await refreshCashierSession()).toBe(false);
    expect(m.clear).toHaveBeenCalled();
    expect(m.set).not.toHaveBeenCalled();
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('offline'))],
    ['API 5xx', async () => fail(503, 'UNAVAILABLE')],
    ['rate limit', async () => fail(429, 'RATE_LIMITED')],
    ['concurrent rotation by another request', async () => fail(409, 'REFRESH_TOKEN_ROTATED')],
  ])('a transient failure (%s) keeps the cookies, so a live session is never signed out', async (_n, respond) => {
    vi.stubGlobal('fetch', vi.fn(respond));
    expect(await refreshCashierSession()).toBe(false);
    expect(m.clear).not.toHaveBeenCalled();
  });

  it.each(['CASHIER_ACCESS_REVOKED', 'ACCOUNT_INACTIVE'])('a definitive refusal (%s) clears the cashier cookies', async (code) => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(403, code)));
    expect(await refreshCashierSession()).toBe(false);
    expect(m.clear).toHaveBeenCalled();
  });

  it('no refresh cookie: nothing to rotate, no network call', async () => {
    m.refresh.mockResolvedValue(undefined);
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await refreshCashierSession()).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('ensureCashierAccess keeps a live access token and refreshes only when it lapsed', async () => {
    const f = vi.fn(async () => ok({ accessToken: 'a', refreshToken: 'r', session: { businessId: 'b', branchId: null, deviceLabel: null } }));
    vi.stubGlobal('fetch', f);
    m.access.mockResolvedValue('LIVE');
    expect(await ensureCashierAccess()).toBe(true);
    expect(f).not.toHaveBeenCalled();
    m.access.mockResolvedValue(undefined);
    expect(await ensureCashierAccess()).toBe(true);
    expect(f).toHaveBeenCalledOnce();
  });
});

describe('cashier reads', () => {
  it('send the cashier token and the bound business/branch headers, and never refresh', async () => {
    m.access.mockResolvedValue('CASHIER');
    m.ctx.mockResolvedValue({ businessId: 'biz', branchId: 'br' });
    const f = vi.fn(async () => ok({ fullName: 'Pat' }));
    vi.stubGlobal('fetch', f);
    expect(await cashierApiFetch('/auth/me')).toEqual({ fullName: 'Pat' });
    const headers = new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get('Authorization')).toBe('Bearer CASHIER');
    expect(headers.get('X-Business-Id')).toBe('biz');
    expect(headers.get('X-Branch-Id')).toBe('br');
    expect(m.set).not.toHaveBeenCalled();
  });
});
