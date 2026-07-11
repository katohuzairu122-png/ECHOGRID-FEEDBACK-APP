import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { AppError } from '../lib/errors';
import type { PlatformRole } from '../db/schema/users';

export type PlatformVariables = {
  platformRole: PlatformRole;
};

/**
 * Guards Platform Admin Console routes. Deliberately independent of
 * resolveTenantContext/requirePermission: platform routes are cross-tenant by
 * definition and carry no X-Business-Id, so there is no tenant membership or
 * business-scoped permission set to check here. Instead this resolves the
 * authenticated user's platformRole with its own direct DB lookup on every
 * request -- same "authorization is never trusted from the JWT, always
 * re-resolved from the DB" precedent tenant-context.ts follows, extended to
 * the one column that lives outside any business scope.
 *
 * Mount directly after `authenticate` (NOT after resolveTenantContext):
 *   app.get('/platform/path', authenticate, requirePlatformRole(['admin']), handler)
 *
 * allowedRoles is an explicit allow-list, not a hierarchy -- a route
 * restricted to ['billing'] does not automatically admit 'admin'. Routes
 * that should admit multiple tiers list them out, e.g. ['billing', 'admin'].
 *
 * Also re-checks user.status === 'active' as defense in depth: platform
 * routes are the highest-blast-radius surface in the system (cross-tenant
 * data, impersonation, billing), so this middleware holds a stricter bar
 * than `authenticate` alone, which does not check status today. Known gap to
 * track, not fixed here: a suspended/deactivated user's still-valid access
 * token remains accepted by ordinary business routes (authenticate never
 * checks status either) -- out of scope for this block since it touches
 * shared auth behavior, not something platform-admin-specific.
 */
export function requirePlatformRole(allowedRoles: PlatformRole[]) {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: AuthVariables & PlatformVariables;
  }>(async (c, next) => {
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const repos = createRepositories(db);
      const user = await repos.users.findById(c.get('userId'));

      if (!user || user.status !== 'active' || !user.platformRole) {
        throw new AppError('Platform admin access required.', 403, 'PLATFORM_ACCESS_DENIED');
      }
      if (!allowedRoles.includes(user.platformRole)) {
        throw new AppError(
          `Missing required platform role: ${allowedRoles.join(' or ')}.`,
          403,
          'PLATFORM_ROLE_DENIED',
          { requiredRoles: allowedRoles, actualRole: user.platformRole },
        );
      }

      c.set('platformRole', user.platformRole);
    } finally {
      c.executionCtx.waitUntil(close());
    }

    await next();
  });
}
