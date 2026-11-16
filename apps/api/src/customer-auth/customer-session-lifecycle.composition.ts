import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createCustomerEmailTrustedSource } from './customer-email-trusted-source';
import { CustomerSessionService } from './customer-session.service';
import { createCustomerSessionLifecycleRoutes } from './customer-session-lifecycle.routes';
import {
  deriveEmailAuthSourceKey,
  isCustomerEmailAuthEnabled,
  resolveEmailAuthConfig,
} from './customer-email-auth.config';

/**
 * CUSTOMER-AUTH-S5-03: refresh and logout for rotating customer sessions.
 *
 * Same gate as email sign-up: a generic 404 unless CUSTOMER_EMAIL_AUTH_ENABLED is exactly "true", a generic 503 when any
 * setting is missing. Only the Web Worker may call it (its signed attribution is required), so a browser can never
 * present a refresh credential directly; the Web Worker holds the credentials in HttpOnly cookies.
 */
export type SessionLifecycleRuntime = {
  sessions: Parameters<typeof createCustomerSessionLifecycleRoutes>[0];
  resolveTrustedSource(request: Request): Promise<string | null>;
  close(): Promise<void>;
};

const MOUNT = '/customer-session';
const noStore = { 'Cache-Control': 'no-store' };

export function createCustomerSessionLifecycleComposition(options: {
  isEnabled: (c: Context) => boolean;
  open: (c: Context) => Promise<SessionLifecycleRuntime | null>;
}) {
  const app = new Hono();
  app.all('/*', async (c) => {
    if (!options.isEnabled(c)) return c.json({ error: 'Not Found' }, 404);
    let runtime: SessionLifecycleRuntime | null = null;
    try {
      runtime = await options.open(c);
    } catch {
      runtime = null;
    }
    if (!runtime) return Response.json({ error: 'Service unavailable' }, { status: 503, headers: noStore });
    try {
      if (!(await runtime.resolveTrustedSource(c.req.raw).catch(() => null))) {
        return Response.json({ error: 'Invalid customer credentials' }, { status: 401, headers: noStore });
      }
      const url = new URL(c.req.url);
      const at = url.pathname.indexOf(MOUNT);
      url.pathname = at >= 0 ? url.pathname.slice(at + MOUNT.length) || '/' : url.pathname;
      return await createCustomerSessionLifecycleRoutes(runtime.sessions).fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
    } finally {
      c.executionCtx.waitUntil(runtime.close());
    }
  });
  return app;
}

export async function openSessionLifecycleRuntime(c: Context): Promise<SessionLifecycleRuntime | null> {
  const env = c.env as Bindings;
  const resolved = resolveEmailAuthConfig(env);
  if (!resolved.ok) return null;
  const { db, close } = await createDb(env.HYPERDRIVE);
  return {
    sessions: new CustomerSessionService(db, resolved.config.session),
    close,
    resolveTrustedSource: createCustomerEmailTrustedSource({
      ...(env.CLIENT_ATTRIBUTION_SECRET ? { attributionSecret: env.CLIENT_ATTRIBUTION_SECRET } : {}),
      ...(env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS ? { previousAttributionSecret: env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS } : {}),
      sourceKeySecret: await deriveEmailAuthSourceKey(resolved.config.hmacSecret),
    }),
  };
}

/** Generic 404 unless CUSTOMER_EMAIL_AUTH_ENABLED is exactly "true". */
export const customerSessionLifecycleComposition = createCustomerSessionLifecycleComposition({
  isEnabled: (c) => isCustomerEmailAuthEnabled(c.env as Bindings),
  open: openSessionLifecycleRuntime,
});
