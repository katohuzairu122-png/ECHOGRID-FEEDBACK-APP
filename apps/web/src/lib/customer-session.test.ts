import { beforeEach, describe, expect, it, vi } from 'vitest';

const { values, set, remove } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn((name: string, value: string, _options: unknown) => { values.set(name, value); }),
    remove: vi.fn((name: string) => { values.delete(name); }),
  };
});
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    set, delete: remove, has: (key: string) => values.has(key),
    get: (key: string) => values.has(key) ? { value: values.get(key) } : undefined,
  }),
}));

import { clearCompatibleCustomerSession, getCompatibleCustomerCredentials, setRotatingCustomerSession } from './customer-session';
import { CUSTOMER_TOKEN_COOKIE } from './customer-cookies';

const opts = { secure: true, httpOnly: true, sameSite: 'lax', path: '/' };
const access = '__Host-ff_customer_access';
const refresh = '__Host-ff_customer_refresh';

describe('rotating customer cookie transport', () => {
  beforeEach(() => { values.clear(); vi.clearAllMocks(); });

  it('preserves legacy selection until the pair takes precedence', async () => {
    values.set(CUSTOMER_TOKEN_COOKIE, 'legacy');
    expect(await getCompatibleCustomerCredentials()).toEqual({ kind: 'legacy', accessToken: 'legacy' });
    values.set(refresh, 'opaque-refresh');
    expect(await getCompatibleCustomerCredentials()).toEqual({
      kind: 'rotating', accessToken: undefined, refreshCredential: 'opaque-refresh',
    });
  });

  it('sets separate host-only credentials and clears them with the same security attributes', async () => {
    const accessExpiresAt = new Date('2026-12-01T00:15:00Z');
    const refreshExpiresAt = new Date('2026-12-02T00:00:00Z');
    values.set(CUSTOMER_TOKEN_COOKIE, 'legacy');
    await setRotatingCustomerSession({
      accessToken: 'fresh', refreshCredential: 'opaque-refresh', accessExpiresAt, refreshExpiresAt,
    });
    expect(remove).toHaveBeenCalledWith(CUSTOMER_TOKEN_COOKIE);
    expect(set).toHaveBeenCalledWith(access, 'fresh', { ...opts, expires: accessExpiresAt });
    expect(set).toHaveBeenCalledWith(refresh, 'opaque-refresh', { ...opts, expires: refreshExpiresAt });
    await clearCompatibleCustomerSession();
    expect(set).toHaveBeenCalledWith(access, '', { ...opts, maxAge: 0 });
    expect(set).toHaveBeenCalledWith(refresh, '', { ...opts, maxAge: 0 });
  });
});
