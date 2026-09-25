import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_REFRESH_TOKEN_COOKIE,
  IMPERSONATING_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from './cookies';

const values = vi.hoisted(() => new Map<string, string>());

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    has: (name: string) => values.has(name),
    get: (name: string) => {
      const value = values.get(name);
      return value === undefined ? undefined : { name, value };
    },
  })),
}));

const { getRefreshTokenForLogout } = await import('./session');

describe('getRefreshTokenForLogout', () => {
  beforeEach(() => values.clear());

  it('returns the ordinary refresh token outside impersonation', async () => {
    values.set(REFRESH_TOKEN_COOKIE, 'ordinary-refresh-token');

    await expect(getRefreshTokenForLogout()).resolves.toBe('ordinary-refresh-token');
  });

  it('returns the stashed administrator token during impersonation', async () => {
    values.set(IMPERSONATING_COOKIE, '1');
    values.set(REFRESH_TOKEN_COOKIE, 'impersonation-session-has-no-refresh-token');
    values.set(ADMIN_REFRESH_TOKEN_COOKIE, 'stashed-admin-refresh-token');

    await expect(getRefreshTokenForLogout()).resolves.toBe('stashed-admin-refresh-token');
  });

  it('falls back safely when an impersonation stash is incomplete', async () => {
    values.set(IMPERSONATING_COOKIE, '1');
    values.set(REFRESH_TOKEN_COOKIE, 'available-refresh-token');

    await expect(getRefreshTokenForLogout()).resolves.toBe('available-refresh-token');
  });
});
