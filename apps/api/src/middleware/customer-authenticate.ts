import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { routeBearerToken } from '../customer-auth/session-tokens';
import { verifyCustomerAccessToken } from '../customer-auth/customer-jwt';
import { AppError } from '../lib/errors';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { CustomerSessionService, type AuthenticatedCustomer } from '../customer-auth/customer-session.service';
import { isCustomerEmailAuthEnabled, resolveEmailAuthConfig } from '../customer-auth/customer-email-auth.config';

export type CustomerAuthVariables = {
  customerId: string;
};

type Rotating = Pick<CustomerSessionService, 'authenticateSessionToken' | 'authenticateLegacyToken'>;

/** Routes the bearer to the verifier for its kind. A rotating session is proven against the database on every request. */
async function identityFor(rotating: Rotating, token: string): Promise<AuthenticatedCustomer | null> {
  const kind = routeBearerToken(token);
  return kind === 'session'
    ? rotating.authenticateSessionToken(token)
    : kind === 'legacy'
      ? rotating.authenticateLegacyToken(token)
      : null;
}

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

/**
 * Mirrors middleware/authenticate.ts but verifies against
 * CUSTOMER_JWT_SECRET and sets customerId, not userId, on context. Guards
 * customer-facing loyalty endpoints (Block 3+) that need to know which
 * customer is calling -- e.g. "my points balance", "my transaction history".
 * Deliberately not composed with resolveTenantContext/requirePermission --
 * those are staff-RBAC concepts that don't apply to a customer session.
 */
export function createCustomerAuthenticate(rotating?: Rotating) {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: CustomerAuthVariables;
  }>(async (c, next) => {
    const token = bearerToken(c);
    if (!token) {
      throw new AppError('Missing or malformed Authorization header.', 401, 'UNAUTHENTICATED');
    }

    if (rotating) {
      const identity = await identityFor(rotating, token);
      if (!identity) {
        throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
      }
      c.set('customerId', identity.customerId);
      return next();
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
}

/** The original verifier: the legacy 90-day customer token only. Used whenever rotating sessions are not active. */
export const legacyCustomerAuthenticate = createCustomerAuthenticate();

export type RotatingSessionOpener = (c: Context) => Promise<{ sessions: Rotating; close(): Promise<void> } | null>;

/**
 * CUSTOMER-AUTH-S5-02: accepts rotating customer sessions beside the legacy 90-day token, ONLY when email auth is
 * enabled. With the flag off this is exactly `legacyCustomerAuthenticate`: no session service is built and behaviour
 * is unchanged for every existing customer.
 *
 * With the flag on, a session token is proven against the database on every request (revoking a session or suspending
 * the customer takes effect immediately), and a legacy token is checked by the session service's legacy rules (kill
 * switch, active customer, per-customer cutoff). The database connection is closed BEFORE the route handler runs.
 *
 * If the flag is on but the configuration is unusable, email auth answers 503 and issues no sessions, so there is no
 * rotating token to reject; the middleware then keeps the legacy behaviour rather than locking every customer out.
 */
export function createFlagAwareCustomerAuthenticate(options: {
  isEnabled: (c: Context) => boolean;
  open: RotatingSessionOpener;
}) {
  return createMiddleware<{
    Bindings: Bindings;
    Variables: CustomerAuthVariables;
  }>(async (c, next) => {
    if (!options.isEnabled(c)) return legacyCustomerAuthenticate(c, next);
    let opened: Awaited<ReturnType<RotatingSessionOpener>> = null;
    try {
      opened = await options.open(c);
    } catch {
      opened = null;
    }
    if (!opened) return legacyCustomerAuthenticate(c, next);

    const token = bearerToken(c);
    if (!token) {
      c.executionCtx.waitUntil(opened.close());
      throw new AppError('Missing or malformed Authorization header.', 401, 'UNAUTHENTICATED');
    }
    let identity: AuthenticatedCustomer | null;
    try {
      identity = await identityFor(opened.sessions, token);
    } finally {
      c.executionCtx.waitUntil(opened.close());
    }
    if (!identity) throw new AppError('Invalid or expired access token.', 401, 'UNAUTHENTICATED');
    c.set('customerId', identity.customerId);
    return next();
  });
}

// The deployed router. Off (legacy only) unless CUSTOMER_EMAIL_AUTH_ENABLED is exactly "true" AND the configuration is
// complete; see CUSTOMER_AUTH_S5_01_EMAIL_AUTH_API.md.
export const customerAuthenticate = createFlagAwareCustomerAuthenticate({
  isEnabled: (c) => isCustomerEmailAuthEnabled(c.env as Bindings),
  open: async (c) => {
    const env = c.env as Bindings;
    const resolved = resolveEmailAuthConfig(env);
    if (!resolved.ok) return null;
    const { db, close } = await createDb(env.HYPERDRIVE);
    return { sessions: new CustomerSessionService(db, resolved.config.session), close };
  },
});
