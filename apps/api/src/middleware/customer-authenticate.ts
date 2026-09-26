import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { verifyCustomerAccessToken } from '../customer-auth/customer-jwt';
import { AppError } from '../lib/errors';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';

export type CustomerAuthVariables = {
  customerId: string;
};

/**
 * Mirrors middleware/authenticate.ts but verifies against
 * CUSTOMER_JWT_SECRET and sets customerId, not userId, on context. Guards
 * customer-facing loyalty endpoints (Block 3+) that need to know which
 * customer is calling -- e.g. "my points balance", "my transaction history".
 * Deliberately not composed with resolveTenantContext/requirePermission --
 * those are staff-RBAC concepts that don't apply to a customer session.
 */
export const customerAuthenticate = createMiddleware<{
  Bindings: Bindings;
  Variables: CustomerAuthVariables;
}>(async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    throw new AppError('Missing or malformed Authorization header.', 401, 'UNAUTHENTICATED');
  }

  let payload;
  try {
    payload = await verifyCustomerAccessToken(token, c.env.CUSTOMER_JWT_SECRET);
  } catch {
    throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
  }

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const customer = await createRepositories(db).customers.findById(payload.sub);
    if (!customer || customer.status !== 'active') {
      throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
    }
    c.set('customerId', payload.sub);
  } finally {
    c.executionCtx.waitUntil(close());
  }

  await next();
});

