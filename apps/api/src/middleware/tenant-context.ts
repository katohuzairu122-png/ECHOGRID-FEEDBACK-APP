import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { AuthorizationService } from '../rbac/authorization.service';
import { AppError } from '../lib/errors';

export type TenantVariables = {
  businessId: string;
  branchId?: string;
  permissions: Set<string>;
};

/**
 * Resolves which business (and optionally branch) a request operates on and
 * confirms the authenticated user (set by `authenticate`, which must run
 * first) actually has an active grant there.
 *
 * Reads the target from X-Business-Id / X-Branch-Id headers for now. Block 7
 * may switch this to a route param (e.g. /businesses/:businessId/...) once
 * real business-scoped routes are designed -- only the two header-read lines
 * below would need to change.
 *
 * On success, attaches businessId, optional branchId, and the user's
 * effective permission set (business-wide + the given branch, if any) to
 * context for requirePermission to consume.
 */
export const resolveTenantContext = createMiddleware<{
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables;
}>(async (c, next) => {
  const businessId = c.req.header('x-business-id');
  if (!businessId) {
    throw new AppError('Missing X-Business-Id header.', 400, 'MISSING_BUSINESS_CONTEXT');
  }
  const branchId = c.req.header('x-branch-id') ?? undefined;

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const authz = new AuthorizationService(repos);

    const membership = await authz.getMembership(c.get('userId'), businessId);
    if (membership.length === 0) {
      throw new AppError('You do not have access to this business.', 403, 'NOT_A_MEMBER');
    }

    const effectivePermissions = await authz.getEffectivePermissions(
      c.get('userId'),
      businessId,
      branchId,
    );

    c.set('businessId', businessId);
    if (branchId) c.set('branchId', branchId);
    c.set('permissions', effectivePermissions);
  } finally {
    c.executionCtx.waitUntil(close());
  }

  await next();
});
