import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({
  host: 'cashier.echo-grid.uk' as string | null,
  refresh: vi.fn(),
  hasRefresh: vi.fn(),
  hasAccess: vi.fn(),
  ctx: vi.fn(),
  me: vi.fn(),
  refreshSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  }),
}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => (k === 'host' ? m.host : null) }) }));
vi.mock('next/navigation', () => ({
  redirect: m.redirect,
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  usePathname: () => '/cashier',
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/cashier/session', () => ({
  getCashierRefreshToken: m.hasRefresh,
  getCashierAccessToken: m.hasAccess,
  getCashierContext: m.ctx,
}));
vi.mock('@/lib/cashier/auth-api', () => ({ cashierApiFetch: m.me, refreshCashierSession: m.refreshSession }));

import { ApiError } from '@/lib/api-error';
import CashierLayout from './layout';
import CashierAppLayout from './(app)/layout';
import { GET as manifestGet } from './manifest.webmanifest/route';
import { GET as refreshGet } from './session/refresh/route';

const prod = (host: string | null, cashierHost: string | null = 'cashier.echo-grid.uk') => {
  m.host = host;
  vi.stubEnv('NODE_ENV', 'production');
  if (cashierHost === null) vi.stubEnv('CASHIER_HOST', '');
  else vi.stubEnv('CASHIER_HOST', cashierHost);
};
const redirected = async (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string; message?: string }) => e.digest ?? e.message);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  m.hasRefresh.mockResolvedValue('refresh');
  m.hasAccess.mockResolvedValue('access');
  m.ctx.mockResolvedValue({ businessId: 'b', businessName: 'Cafe', branchId: null, branchName: null, deviceLabel: null });
  m.me.mockResolvedValue({ fullName: 'Pat' });
});

describe('availability: cashier routes exist only on the cashier host in production', () => {
  it('serves on the cashier host', async () => {
    prod('cashier.echo-grid.uk');
    await expect(CashierLayout({ children: null })).resolves.toBeTruthy();
    expect((await manifestGet()).status).toBe(200);
  });

  it.each([['echo-grid.uk'], ['echo-grid-feedback-web.example.workers.dev']])('is a 404 on %s', async (host) => {
    prod(host);
    await expect(CashierLayout({ children: null })).rejects.toThrow('NEXT_NOT_FOUND');
    expect((await manifestGet()).status).toBe(404);
    expect((await refreshGet(new NextRequest(`https://${host}/cashier/session/refresh`))).status).toBe(404);
  });

  it('is a 404 everywhere in production when CASHIER_HOST is unset (nothing deployed)', async () => {
    prod('cashier.echo-grid.uk', null);
    await expect(CashierLayout({ children: null })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('manifest', () => {
  it('is an installable, cashier-scoped app identity', async () => {
    prod('cashier.echo-grid.uk');
    const manifest = await (await manifestGet()).json();
    expect(manifest).toMatchObject({ name: 'Echo Grid Cashier', display: 'standalone', start_url: '/cashier/', scope: '/cashier/', id: '/cashier' });
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });
});

describe('session gate', () => {
  it('no refresh cookie: sign in', async () => {
    m.hasRefresh.mockResolvedValue(undefined);
    expect(await redirected(CashierAppLayout({ children: null }))).toContain('/cashier/login');
  });

  it('lapsed access token: the refresh handler decides', async () => {
    m.hasAccess.mockResolvedValue(undefined);
    expect(await redirected(CashierAppLayout({ children: null }))).toContain('/cashier/session/refresh');
  });

  it('a token the API rejects (revoked session) goes to the refresh handler, which cannot revive it', async () => {
    m.me.mockRejectedValue(new ApiError('no', 401, 'UNAUTHENTICATED'));
    expect(await redirected(CashierAppLayout({ children: null }))).toContain('/cashier/session/refresh');
  });

  it('an unreachable API does not lock the cashier out of the screen', async () => {
    m.me.mockRejectedValue(new Error('network'));
    await expect(CashierAppLayout({ children: null })).resolves.toBeTruthy();
  });

  it('a missing context cookie goes to the refresh handler (which re-issues it), never to a sign-in loop', async () => {
    m.ctx.mockResolvedValue(null);
    expect(await redirected(CashierAppLayout({ children: null }))).toContain('/cashier/session/refresh');
  });
});

describe('refresh route', () => {
  const call = (next?: string) =>
    refreshGet(new NextRequest(`https://cashier.echo-grid.uk/cashier/session/refresh${next ? `?next=${encodeURIComponent(next)}` : ''}`));

  beforeEach(() => prod('cashier.echo-grid.uk'));

  it('success returns to the cashier app; the destination can only be inside it', async () => {
    m.refreshSession.mockResolvedValue(true);
    expect((await call()).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier');
    expect((await call('/cashier/redeem')).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier/redeem');
    for (const bad of ['https://evil.example/x', '//evil.example', '/dashboard', '/cashier/session/refresh', '/cashier/login'])
      expect((await call(bad)).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier');
  });

  it('refuses to rotate a token for a cross-site navigation, and allows same-origin and typed URLs', async () => {
    m.refreshSession.mockResolvedValue(true);
    const withSite = (site: string) =>
      refreshGet(new NextRequest('https://cashier.echo-grid.uk/cashier/session/refresh', { headers: { 'sec-fetch-site': site } }));
    expect((await withSite('cross-site')).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier');
    expect((await withSite('same-site')).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier');
    expect(m.refreshSession).not.toHaveBeenCalled();
    await withSite('same-origin');
    await withSite('none');
    expect(m.refreshSession).toHaveBeenCalledTimes(2);
  });

  it('a session that cannot refresh (revoked, expired, replayed) lands on the sign-in', async () => {
    m.refreshSession.mockResolvedValue(false);
    expect((await call('/cashier/redeem')).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier/login?reason=session');
  });
});
