import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { CustomerSessionService } from '../customer-auth/customer-session.service';
import { CustomerPasswordAuthService } from '../customer-auth/customer-password-auth.service';
import { createDurableObjectPbkdf2Worker } from '../auth/pbkdf2-worker';
import { createSharedEmailAuthLimiter } from '../customer-auth/customer-email-rate-limit';
import { createCustomerEmailTrustedSource } from '../customer-auth/customer-email-trusted-source';
import { deriveEmailAuthSourceKey, isCustomerEmailAuthEnabled, resolveEmailAuthConfig } from '../customer-auth/customer-email-auth.config';
import { createCustomerDeletionRoutes, type CustomerDeletionDeps } from './customer-deletion.routes';

const MOUNT = '/customer-account';
const noStore = { 'Cache-Control': 'no-store' };

export type CustomerDeletionRuntime = {
  deps: CustomerDeletionDeps;
  resolveTrustedSource(request: Request): Promise<string | null>;
  close(): Promise<void>;
};

/** Same gate as the rest of the rotating-session surface: generic 404 unless CUSTOMER_EMAIL_AUTH_ENABLED is exactly "true"; only the Web Worker may call. */
export function createCustomerDeletionComposition(options: {
  isEnabled: (c: Context) => boolean;
  open: (c: Context) => Promise<CustomerDeletionRuntime | null>;
}) {
  const app = new Hono();
  app.all('/*', async (c) => {
    if (!options.isEnabled(c)) return c.json({ error: 'Not Found' }, 404);
    let runtime: CustomerDeletionRuntime | null = null;
    try { runtime = await options.open(c); } catch { runtime = null; }
    if (!runtime) return Response.json({ error: 'Service unavailable' }, { status: 503, headers: noStore });
    try {
      if (!(await runtime.resolveTrustedSource(c.req.raw).catch(() => null))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
      }
      const url = new URL(c.req.url);
      const at = url.pathname.indexOf(MOUNT);
      url.pathname = at >= 0 ? url.pathname.slice(at + MOUNT.length) || '/' : url.pathname;
      return await createCustomerDeletionRoutes(runtime.deps).fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
    } finally {
      c.executionCtx.waitUntil(runtime.close());
    }
  });
  return app;
}

export async function openCustomerDeletionRuntime(c: Context): Promise<CustomerDeletionRuntime | null> {
  const env = c.env as Bindings;
  const resolved = resolveEmailAuthConfig(env);
  if (!resolved.ok || !env.PASSWORD_HASHER) return null;
  const { db, close } = await createDb(env.HYPERDRIVE);
  const repos = createRepositories(db);
  const sessions = new CustomerSessionService(db, resolved.config.session);
  const passwordAuth = new CustomerPasswordAuthService(db, sessions, createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER), {
    passwordMinLength: resolved.config.passwordMinLength,
    phoneProofMaxAgeSeconds: 300,
  });
  const limiter = createSharedEmailAuthLimiter(env.CUSTOMER_AUTH_RATE_LIMIT);
  return {
    deps: {
      sessions,
      reauthenticate: (customerId, sessionId, currentPassword) =>
        passwordAuth.reauthenticateSession({ customerId, sessionId, currentPassword }),
      allowReauthentication: (customerId) =>
        limiter({ key: `customer-deletion:reauth:${customerId}`, limit: 5, windowSeconds: 900 }),
      requests: repos.customerDeletionRequests,
      audit: repos.auditLog,
      stepUpWindowSeconds: resolved.config.session.stepUpWindowSeconds,
    },
    close,
    resolveTrustedSource: createCustomerEmailTrustedSource({
      ...(env.CLIENT_ATTRIBUTION_SECRET ? { attributionSecret: env.CLIENT_ATTRIBUTION_SECRET } : {}),
      ...(env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS ? { previousAttributionSecret: env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS } : {}),
      sourceKeySecret: await deriveEmailAuthSourceKey(resolved.config.hmacSecret),
    }),
  };
}

export const customerDeletionComposition = createCustomerDeletionComposition({
  isEnabled: (c) => isCustomerEmailAuthEnabled(c.env as Bindings),
  open: openCustomerDeletionRuntime,
});
