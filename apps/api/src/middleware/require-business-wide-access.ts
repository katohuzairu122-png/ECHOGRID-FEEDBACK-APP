import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';
import { assertBusinessWideAccess } from '../rbac/branch-access';
import { AppError } from '../lib/errors';
import { assertTenantAuthorizationContext } from './tenant-authorization-context';

export const requireBusinessWideAccess = createMiddleware<{
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables;
}>(async (c, next) => {
  assertTenantAuthorizationContext(c.var);
  assertBusinessWideAccess(c.var);
  await next();
});

export function requireAuthorizedBranchParam(param = 'id') {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: AuthVariables & TenantVariables;
  }>(async (c, next) => {
    assertTenantAuthorizationContext(c.var);
    const requestedBranchId = c.req.param(param);
    if (!requestedBranchId) {
      throw new AppError('Missing branch route parameter.', 403, 'BRANCH_ACCESS_DENIED');
    }
    if (!c.get('businessWideAccess') && requestedBranchId !== c.get('branchId')) {
      assertBusinessWideAccess(c.var);
    }
    await next();
  });
}
