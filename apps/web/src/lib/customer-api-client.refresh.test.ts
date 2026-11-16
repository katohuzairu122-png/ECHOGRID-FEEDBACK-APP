import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const values = new Map<string, string>();
  return { values, redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }), fetch: vi.fn() };
});
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: vi.fn(), delete: vi.fn(), has: (k: string) => h.values.has(k), get: (k: string) => (h.values.has(k) ? { value: h.values.get(k) } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));

import { customerApiFetch } from './customer-api-client';
import { CUSTOMER_TOKEN_COOKIE } from './customer-cookies';

const ACCESS = '__Host-ff_customer_access';
const REFRESH = '__Host-ff_customer_refresh';
const ok = () => Response.json({ success: true, data: { hello: 'world' } });
const unauthorized = () => Response.json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'no' } }, { status: 401 });
const target = (to: string) => `REDIRECT:${to}`;

beforeEach(() => {
  h.values.clear();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', h.fetch);
});

describe('customerApiFetch with rotating sessions', () => {
  it('sends the rotating access cookie as the bearer', async () => {
    h.values.set(ACCESS, 'access-token');
    h.values.set(REFRESH, 'r'.repeat(43));
    h.fetch.mockResolvedValue(ok());
    expect(await customerApiFetch('/loyalty/me/x')).toEqual({ hello: 'world' });
    expect((h.fetch.mock.calls[0]![1] as RequestInit).headers).toSatisfy((hd: Headers) => hd.get('authorization') === 'Bearer access-token');
  });

  it('an expired access cookie with a refresh credential redirects to the refresh route, carrying where to return', async () => {
    h.values.set(REFRESH, 'r'.repeat(43));
    await expect(customerApiFetch('/loyalty/me/x', {}, '/loyalty/dashboard/wallet')).rejects.toThrow(
      target('/loyalty/session/refresh?next=%2Floyalty%2Fdashboard%2Fwallet'),
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('a 401 on a rotating session redirects to refresh once; just after a refresh it goes to sign-in instead (no loop)', async () => {
    h.values.set(ACCESS, 'access-token');
    h.values.set(REFRESH, 'r'.repeat(43));
    h.fetch.mockResolvedValue(unauthorized());
    await expect(customerApiFetch('/loyalty/me/x')).rejects.toThrow(target('/loyalty/session/refresh?next=%2Floyalty%2Fdashboard'));
    h.values.set('ff_customer_refreshed', '1');
    await expect(customerApiFetch('/loyalty/me/x')).rejects.toThrow(target('/loyalty/login'));
  });

  it('no credentials at all goes to sign-in', async () => {
    await expect(customerApiFetch('/loyalty/me/x')).rejects.toThrow(target('/loyalty/login'));
  });

  it('a legacy-only customer is unchanged: legacy bearer, and a 401 goes to sign-in, never to refresh', async () => {
    h.values.set(CUSTOMER_TOKEN_COOKIE, 'legacy-token');
    h.fetch.mockResolvedValue(unauthorized());
    await expect(customerApiFetch('/loyalty/me/x')).rejects.toThrow(target('/loyalty/login'));
    expect((h.fetch.mock.calls[0]![1] as RequestInit).headers).toSatisfy((hd: Headers) => hd.get('authorization') === 'Bearer legacy-token');
  });
});
