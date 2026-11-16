import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn((name: string, value: string, _o: unknown) => { values.set(name, value); }),
    remove: vi.fn((name: string) => { values.delete(name); }),
    api: vi.fn(),
    redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
  };
});
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: h.set, delete: h.remove, has: (k: string) => h.values.has(k),
    get: (k: string) => (h.values.has(k) ? { value: h.values.get(k) } : undefined),
  }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('./customer-email-auth-client', () => ({
  callCustomerAuthApi: h.api,
  isCustomerEmailAuthWebEnabled: () => process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true',
}));
vi.mock('./api-client', async (orig) => ({ ...(await orig<typeof import('./api-client')>()), API_BASE_URL: 'https://api.test' }));

import { getCustomerToken, hasCustomerSession, hasRotatingRefreshCredential, markCustomerRefreshed, wasCustomerRecentlyRefreshed } from './customer-session';
import { refreshRotatingCustomerSession, revokeRotatingCustomerSession } from './customer-session-refresh';
import { CUSTOMER_TOKEN_COOKIE } from './customer-cookies';

const ACCESS = '__Host-ff_customer_access';
const REFRESH = '__Host-ff_customer_refresh';
const RT = 'a'.repeat(43);
const fresh = { accessToken: 'new-access', refreshCredential: 'b'.repeat(43), accessExpiresAt: '2026-12-01T00:15:00Z', refreshExpiresAt: '2026-12-31T00:00:00Z' };

beforeEach(() => { h.values.clear(); vi.clearAllMocks(); });

describe('customer bearer selection (rotating beats legacy)', () => {
  it('uses the legacy cookie when no rotating cookie exists', async () => {
    h.values.set(CUSTOMER_TOKEN_COOKIE, 'legacy');
    expect(await getCustomerToken()).toBe('legacy');
    expect(await hasCustomerSession()).toBe(true);
    expect(await hasRotatingRefreshCredential()).toBe(false);
  });
  it('uses the rotating ACCESS cookie, and is undefined once it has expired (the cue to refresh), never the legacy token', async () => {
    h.values.set(CUSTOMER_TOKEN_COOKIE, 'legacy');
    h.values.set(REFRESH, RT);
    expect(await getCustomerToken()).toBeUndefined();
    h.values.set(ACCESS, 'access');
    expect(await getCustomerToken()).toBe('access');
    expect(await hasRotatingRefreshCredential()).toBe(true);
  });
  it('a refresh-only customer still counts as signed in for page gates, and nobody else does', async () => {
    expect(await hasCustomerSession()).toBe(false);
    h.values.set(REFRESH, RT);
    expect(await hasCustomerSession()).toBe(true);
  });
  it('the recently-refreshed marker is short-lived, host-only and HttpOnly', async () => {
    expect(await wasCustomerRecentlyRefreshed()).toBe(false);
    await markCustomerRefreshed();
    expect(h.set).toHaveBeenCalledWith('ff_customer_refreshed', '1', expect.objectContaining({ httpOnly: true, secure: true, maxAge: 60 }));
    expect(await wasCustomerRecentlyRefreshed()).toBe(true);
  });
});

describe('refreshRotatingCustomerSession', () => {
  it('stores the rotated pair and reports refreshed', async () => {
    h.values.set(REFRESH, RT);
    h.api.mockResolvedValue({ status: 200, body: fresh });
    expect(await refreshRotatingCustomerSession()).toBe('refreshed');
    expect(h.api).toHaveBeenCalledWith('/customer-session/refresh', { bearer: RT });
    expect(h.values.get(ACCESS)).toBe('new-access');
    expect(h.values.get(REFRESH)).toBe(fresh.refreshCredential);
  });
  it('a refused or replayed credential (401) clears the session', async () => {
    h.values.set(REFRESH, RT);
    h.values.set(ACCESS, 'old');
    h.api.mockResolvedValue({ status: 401, body: null });
    expect(await refreshRotatingCustomerSession()).toBe('invalid');
    expect(h.values.get(REFRESH)).toBe('');
    expect(h.values.get(ACCESS)).toBe('');
  });
  it('a concurrent-refresh conflict (409) KEEPS the session: the API revokes nothing, so a second tab must not sign the customer out', async () => {
    h.values.set(REFRESH, RT);
    h.values.set(ACCESS, 'old');
    h.api.mockResolvedValue({ status: 409, body: null });
    expect(await refreshRotatingCustomerSession()).toBe('conflict');
    expect(h.values.get(REFRESH)).toBe(RT);
    expect(h.values.get(ACCESS)).toBe('old');
  });
  it('a transient failure or malformed reply keeps the cookies so a retry can succeed', async () => {
    h.values.set(REFRESH, RT);
    for (const reply of [{ status: 503, body: null }, { status: 200, body: { accessToken: 'x' } }]) {
      h.api.mockResolvedValue(reply);
      expect(await refreshRotatingCustomerSession()).toBe('unavailable');
      expect(h.values.get(REFRESH)).toBe(RT);
    }
    h.api.mockRejectedValue(new Error('network'));
    expect(await refreshRotatingCustomerSession()).toBe('unavailable');
  });
  it('with no rotating refresh credential there is nothing to refresh', async () => {
    h.values.set(CUSTOMER_TOKEN_COOKIE, 'legacy');
    expect(await refreshRotatingCustomerSession()).toBe('invalid');
    expect(h.api).not.toHaveBeenCalled();
  });
});

describe('revokeRotatingCustomerSession', () => {
  it('revokes with the access token, then clears every customer cookie (legacy included)', async () => {
    h.values.set(ACCESS, 'access');
    h.values.set(REFRESH, RT);
    h.values.set(CUSTOMER_TOKEN_COOKIE, 'legacy');
    h.api.mockResolvedValue({ status: 204, body: null });
    await revokeRotatingCustomerSession();
    expect(h.api).toHaveBeenCalledWith('/customer-session/logout', { bearer: 'access' });
    expect(h.values.get(ACCESS)).toBe('');
    expect(h.values.get(REFRESH)).toBe('');
    expect(h.values.has(CUSTOMER_TOKEN_COOKIE)).toBe(false);
  });
  it('with an expired access cookie it renews once to obtain a bearer for the revocation', async () => {
    h.values.set(REFRESH, RT);
    h.api.mockResolvedValueOnce({ status: 200, body: fresh }).mockResolvedValueOnce({ status: 204, body: null });
    await revokeRotatingCustomerSession();
    expect(h.api).toHaveBeenNthCalledWith(2, '/customer-session/logout', { bearer: 'new-access' });
  });
  it('always signs this device out, even when the API is unreachable', async () => {
    h.values.set(ACCESS, 'access');
    h.values.set(REFRESH, RT);
    h.api.mockRejectedValue(new Error('down'));
    await revokeRotatingCustomerSession();
    expect(h.values.get(REFRESH)).toBe('');
  });
  it('a legacy-only customer simply has the cookie cleared and no API call is made', async () => {
    h.values.set(CUSTOMER_TOKEN_COOKIE, 'legacy');
    await revokeRotatingCustomerSession();
    expect(h.api).not.toHaveBeenCalled();
    expect(h.values.has(CUSTOMER_TOKEN_COOKIE)).toBe(false);
  });
});
