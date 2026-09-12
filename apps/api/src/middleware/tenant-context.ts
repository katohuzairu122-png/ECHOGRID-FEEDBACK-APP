import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { AuthorizationService } from '../rbac/authorization.service';
import { assertBusinessIsUsable } from '../rbac/business-access';
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

    // Order is load-bearing: membership FIRST, then status. Reversed, any
    // authenticated user could tell "this business exists and is suspended"
    // apart from "no such business" for an id they have no relationship
    // with. By running second, this only ever answers a confirmed member.
    //
    // Costs one primary-key lookup per tenant request. Accepted: it is the
    // only place a suspended or soft-deleted business can be stopped on the
    // staff surface, and the alternative -- caching status in KV or folding
    // it into the membership query -- trades a clear boundary for a stale
    // one. See rbac/business-access.ts for what the statuses mean.
    assertBusinessIsUsable(await repos.businesses.findById(businessId));

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
