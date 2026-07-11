import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { verifyAccessToken } from '../auth/jwt';
import { AppError } from '../lib/errors';

export type AuthVariables = {
  userId: string;
  // Set only when the verified token carries an impersonatedBy claim
  // (Platform Admin Console Block 4, see auth/jwt.ts) -- the platform
  // admin's own userId, distinct from userId above (which is the
  // impersonated user for the rest of this request). auditTrail
  // (middleware/audit.ts) reads this to attribute every action taken during
  // an impersonated session to both parties.
  impersonatedBy?: string;
};

/**
 * Verifies the `Authorization: Bearer <token>` header against
 * JWT_ACCESS_SECRET and attaches the authenticated userId to context. Must
 * run before resolveTenantContext / requirePermission, which depend on it.
 */
export const authenticate = createMiddleware<{ Bindings: Bindings; Variables: AuthVariables }>(
  async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      throw new AppError('Missing or malformed Authorization header.', 401, 'UNAUTHENTICATED');
    }

    try {
      const payload = await verifyAccessToken(token, c.env.JWT_ACCESS_SECRET);
      c.set('userId', payload.sub);
      if (payload.impersonatedBy) {
        c.set('impersonatedBy', payload.impersonatedBy);
      }
    } catch {
      throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
    }

    await next();
  },
);
