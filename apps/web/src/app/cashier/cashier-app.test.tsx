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
import { CashierShell as CashierAppLayout } from '@/components/cashier/cashier-shell';
import { GET as manifestGet } from './manifest.webmanifest/route';
import { GET as refreshGet, POST as refreshPost } from './session/refresh/route';

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

describe('refresh route (SEC-CASHIER-R1 F3)', () => {
  const URL_ = 'https://cashier.echo-grid.uk/cashier/session/refresh';
  const get = (next?: string, headers: Record<string, string> = {}) =>
    refreshGet(new NextRequest(`${URL_}${next ? `?next=${encodeURIComponent(next)}` : ''}`, { headers }));
  const post = (headers: Record<string, string> = {}, next?: string) => {
    const body = new FormData();
    if (next !== undefined) body.set('next', next);
    return refreshPost(new NextRequest(URL_, { method: 'POST', headers, body }));
  };
  const same = { origin: 'https://cashier.echo-grid.uk' };

  beforeEach(() => prod('cashier.echo-grid.uk'));

  it('GET never rotates a token and never redirects: it is a same-origin hand-off page', async () => {
    for (const site of ['same-origin', 'same-site', 'cross-site', 'none', undefined]) {
      const res = await get(undefined, site ? { 'sec-fetch-site': site } : {});
      expect(res.status, String(site)).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      expect(html).toContain('method="post"');
      expect(html).toContain('action="/cashier/session/refresh"');
    }
    expect(m.refreshSession).not.toHaveBeenCalled(); // a cross-site navigation, link or bookmark cannot force a rotation
  });

  it('the hand-off page carries only a validated next path, escaped', async () => {
    expect(await (await get('/cashier/redeem')).text()).toContain('value="/cashier/redeem"');
    for (const bad of ['https://evil.example/x', '//evil.example', '/dashboard', '/cashier/session/refresh', '/cashier/login', '/cashier\\evil', '"><script>x</script>'])
      expect(await (await get(bad)).text(), bad).toContain('value="/cashier"');
  });

  it('POST from the same origin rotates once and returns into the app', async () => {
    m.refreshSession.mockResolvedValue(true);
    const res = await post(same, '/cashier/redeem');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier/redeem');
    expect(m.refreshSession).toHaveBeenCalledOnce();
    for (const bad of ['https://evil.example/x', '//evil.example', '/dashboard', '/cashier/session/refresh'])
      expect((await post(same, bad)).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier');
  });

  it('accepts Sec-Fetch-Site same-origin when no Origin header is sent', async () => {
    m.refreshSession.mockResolvedValue(true);
    expect((await post({ 'sec-fetch-site': 'same-origin' })).headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier');
    expect(m.refreshSession).toHaveBeenCalledOnce();
  });

  it('a cross-site POST is refused without touching the session, and ends at the stable sign-in', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, {}]) {
      const res = await post(headers);
      expect(res.status, JSON.stringify(headers)).toBe(303);
      expect(res.headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier/login?reason=session');
    }
    expect(m.refreshSession).not.toHaveBeenCalled();
  });

  it('every failure (revoked, expired, transient) ends at the sign-in that never redirects back', async () => {
    m.refreshSession.mockResolvedValue(false);
    const res = await post(same, '/cashier/redeem');
    expect(res.headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier/login?reason=session');
    expect(res.headers.get('location')).not.toContain('/session/refresh');
  });

  it('uses the Host the browser sent, not the server bind address, for redirects and the same-origin check', async () => {
    m.refreshSession.mockResolvedValue(true);
    const req = (headers: Record<string, string>) => {
      const body = new FormData();
      body.set('next', '/cashier');
      return refreshPost(new NextRequest('http://localhost:3000/cashier/session/refresh', { method: 'POST', headers, body }));
    };
    const ok = await req({ host: 'cashier.echo-grid.uk', 'x-forwarded-proto': 'https', origin: 'https://cashier.echo-grid.uk' });
    expect(ok.headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier');
    m.refreshSession.mockClear();
    const forged = await req({ host: 'cashier.echo-grid.uk', 'x-forwarded-proto': 'https', origin: 'https://evil.example' });
    expect(forged.headers.get('location')).toBe('https://cashier.echo-grid.uk/cashier/login?reason=session');
    expect(m.refreshSession).not.toHaveBeenCalled();
  });

  it('is a 404 off the cashier host, for both methods', async () => {
    prod('echo-grid.uk');
    expect((await get()).status).toBe(404);
    expect((await post(same)).status).toBe(404);
    expect(m.refreshSession).not.toHaveBeenCalled();
  });
});
