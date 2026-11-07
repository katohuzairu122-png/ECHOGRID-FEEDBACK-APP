import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { AppError } from '../lib/errors';
import { assertTenantAuthorizationContext } from './tenant-authorization-context';

/**
 * Guards a route behind a single permission key. Must run after
 * `authenticate` + `resolveTenantContext`, which populate the permission set
 * this reads -- mounting order matters:
 *   app.get('/path', authenticate, resolveTenantContext, requirePermission('x:y'), handler)
 */
export function requirePermission(key: string) {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: AuthVariables & TenantVariables;
  }>(async (c, next) => {
    assertTenantAuthorizationContext(c.var);
    if (!c.get('permissions').has(key)) {
      throw new AppError(`Missing required permission: ${key}`, 403, 'PERMISSION_DENIED', {
        requiredPermission: key,
      });
    }
    await next();
  });
}
