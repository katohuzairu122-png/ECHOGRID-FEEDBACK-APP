import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { AuthVariables } from '../middleware/authenticate';
import type { PlatformVariables } from '../middleware/require-platform-role';
import type { PlatformRole } from '../db/schema/users';
import {
  platformRoleHasCommunityPermission,
  requireCommunityPlatformPermission,
} from './community-permissions';
import { errorHandler } from '../lib/error-handler';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables;
};

function appFor(role: PlatformRole) {
  const app = new Hono<Env>();
  app.onError(async (error, context) => errorHandler(error, context as never));
  app.use('*', async (c, next) => {
    c.set('userId', '11111111-1111-4111-8111-111111111111');
    c.set('platformRole', role);
    await next();
  });
  app.get(
    '/view',
    requireCommunityPlatformPermission('community:rules:view'),
    (c) => c.json({ ok: true }),
  );
  app.post(
    '/manage',
    requireCommunityPlatformPermission('community:rules:manage'),
    (c) => c.json({ ok: true }),
  );
  return app;
}

describe('Community platform permission matrix', () => {
  it.each(['support', 'billing', 'admin'] as const)(
    '%s may view Community Point rules',
    (role) => {
      expect(
        platformRoleHasCommunityPermission(role, 'community:rules:view'),
      ).toBe(true);
    },
  );

  it.each(['support', 'billing'] as const)(
    '%s may not manage Community Point rules',
    (role) => {
      expect(
        platformRoleHasCommunityPermission(role, 'community:rules:manage'),
      ).toBe(false);
    },
  );

  it('admin owns all frozen Split 05 Community platform permissions', () => {
    for (const permission of [
      'community:rules:view',
      'community:rules:manage',
      'community:ledger:view',
      'community:adjust',
    ] as const) {
      expect(platformRoleHasCommunityPermission('admin', permission)).toBe(true);
    }
  });

  it.each(['support', 'billing'] as const)(
    'middleware rejects %s from manage authority',
    async (role) => {
      const response = await appFor(role).request('/manage', { method: 'POST' });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: {
          code: 'PLATFORM_PERMISSION_DENIED',
          details: { requiredPermission: 'community:rules:manage' },
        },
      });
    },
  );

  it('middleware admits admin to manage authority', async () => {
    const response = await appFor('admin').request('/manage', { method: 'POST' });
    expect(response.status).toBe(200);
  });
});
