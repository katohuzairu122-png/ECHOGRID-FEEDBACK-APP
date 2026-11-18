import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../lib/error-handler';
import type { Bindings } from '../config/env';
import type { AuthVariables } from '../middleware/authenticate';
import type { PlatformVariables } from '../middleware/require-platform-role';
import type { PlatformRole } from '../db/schema/users';
import {
  PROFILE_PLATFORM_PERMISSIONS, platformRoleHasProfilePermission, requireProfilePlatformPermission,
} from './business-profile-permissions';

describe('profile platform permission matrix (D-03)', () => {
  it.each(PROFILE_PLATFORM_PERMISSIONS)('only the platform admin holds %s', (permission) => {
    expect(platformRoleHasProfilePermission('admin', permission)).toBe(true);
    expect(platformRoleHasProfilePermission('support', permission)).toBe(false);
    expect(platformRoleHasProfilePermission('billing', permission)).toBe(false);
  });

  it('holds nothing for an unknown or missing role (fails closed, no throw)', () => {
    expect(platformRoleHasProfilePermission(undefined, 'profile:moderate')).toBe(false);
    expect(platformRoleHasProfilePermission('owner' as never, 'profile:moderate')).toBe(false);
  });

  it('is exactly one code-owned key and is not a business permission key', () => {
    expect([...PROFILE_PLATFORM_PERMISSIONS]).toEqual(['profile:moderate']);
  });
});

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables };

describe('requireProfilePlatformPermission middleware', () => {
  const appFor = (role: PlatformRole | undefined) => {
    const app = new Hono<Env>();
    app.onError(async (error, context) => errorHandler(error, context as never));
    app.use('*', async (c, next) => {
      c.set('userId', '11111111-1111-4111-8111-111111111111');
      if (role !== undefined) c.set('platformRole', role);
      await next();
    });
    app.get('/review', requireProfilePlatformPermission('profile:moderate'), (c) => c.json({ reached: true }));
    return app;
  };

  it('lets the platform admin through', async () => {
    const response = await appFor('admin').request('/review');
    expect(response.status).toBe(200);
  });

  it.each(['support', 'billing'] as const)('refuses platform %s with 403 PLATFORM_PERMISSION_DENIED and never reaches the handler', async (role) => {
    const response = await appFor(role).request('/review');
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: string; details?: { requiredPermission?: string } } };
    expect(body.error?.code).toBe('PLATFORM_PERMISSION_DENIED');
    expect(body.error?.details?.requiredPermission).toBe('profile:moderate');
  });

  it('fails closed when no platform role is resolved', async () => {
    const response = await appFor(undefined).request('/review');
    expect(response.status).toBe(403);
  });
});
