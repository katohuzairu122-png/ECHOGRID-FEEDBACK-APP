import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { verifyAccessToken } from '../auth/jwt';
import { AppError } from '../lib/errors';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { isPlatformImpersonationEnabled } from '../platform/impersonation-policy';
import { isCashierRouteAllowed, toApiPath } from './cashier-scope';

export type AuthVariables = {
  userId: string;
  // Set only when the verified token carries an impersonatedBy claim
  // (Platform Admin Console Block 4, see auth/jwt.ts) -- the platform
  // admin's own userId, distinct from userId above (which is the
  // impersonated user for the rest of this request). auditTrail
  // (middleware/audit.ts) reads this to attribute every action taken during
  // an impersonated session to both parties.
  impersonatedBy?: string;
  // Set only for a cashier-scoped token (CASHIER-PWA-01 C2): the business and branch the token is bound to, read from
  // the SIGNED claims. resolveTenantContext treats these as the proof of context; request headers must match them.
  cashier?: { businessId: string; branchId: string | null };
};

/**
 * Verifies the `Authorization: Bearer <token>` header and revalidates the
 * represented identities against current database state. JWT validity alone
 * is insufficient: account suspension, deactivation, deletion, and removal
 * must take effect immediately rather than waiting for access-token expiry.
 * Impersonation tokens validate both the target and the platform actor.
 * Must run before resolveTenantContext / requirePermission, which depend on
 * the attached identity.
 */
export const authenticate = createMiddleware<{ Bindings: Bindings; Variables: AuthVariables }>(
  async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      throw new AppError('Missing or malformed Authorization header.', 401, 'UNAUTHENTICATED');
    }

    let payload;
    try {
      payload = await verifyAccessToken(token, c.env.JWT_ACCESS_SECRET);
    } catch {
      throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
    }

    // A cashier-scoped token is accepted only on the explicit allow-list. The global guard has already applied the same
    // rule; checking again here keeps authenticate safe even if it is ever mounted without the guard.
    if (payload.client === 'cashier') {
      const apiPath = toApiPath(c.req.path);
      if (apiPath === null || !isCashierRouteAllowed(c.req.method, apiPath)) {
        throw new AppError('This token cannot be used for this request.', 403, 'CASHIER_ROUTE_DENIED');
      }
    }

    // A disabled flag also invalidates ALREADY-ISSUED impersonation JWTs.
    // Gating issuance alone leaves up to 30 minutes of unwanted access.
    // Check before database lookups; return the normal opaque auth denial.
    if (payload.impersonatedBy && !isPlatformImpersonationEnabled(c.env)) {
      throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
    }

    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const users = createRepositories(db).users;
      const subject = await users.findById(payload.sub);
      if (!subject || subject.status !== 'active') {
        throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
      }

      if (payload.impersonatedBy) {
        const actor = await users.findById(payload.impersonatedBy);
        if (!actor || actor.status !== 'active') {
          throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
        }
      }

      c.set('userId', payload.sub);
      if (payload.client === 'cashier' && payload.bid) {
        c.set('cashier', { businessId: payload.bid, branchId: payload.brid ?? null });
      }
      if (payload.impersonatedBy) {
        c.set('impersonatedBy', payload.impersonatedBy);
      }
    } finally {
      c.executionCtx.waitUntil(close());
    }

    await next();
  },
);
