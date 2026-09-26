import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { assertBusinessWideAccess } from '../rbac/branch-access';

export const requireBusinessWideAccess = createMiddleware<{
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables;
}>(async (c, next) => {
  assertBusinessWideAccess(c.var);
  await next();
});

export function requireAuthorizedBranchParam(param = 'id') {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: AuthVariables & TenantVariables;
  }>(async (c, next) => {
    if (!c.get('businessWideAccess') && c.req.param(param) !== c.get('branchId')) {
      assertBusinessWideAccess(c.var);
    }
    await next();
  });
}
