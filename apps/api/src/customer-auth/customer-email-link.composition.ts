import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createDurableObjectPbkdf2Worker } from '../auth/pbkdf2-worker';
import { createAccountSecurityEmailService } from '../notifications/email.service';
import { createCustomerEmailTrustedSource } from './customer-email-trusted-source';
import { createSharedEmailAuthLimiter } from './customer-email-rate-limit';
import { createEmailLinkProofDelivery } from './customer-email-auth.delivery';
import { CustomerSessionService } from './customer-session.service';
import { createCustomerEmailLinkService } from './customer-email-link.service';
import { createIsolatedCustomerEmailLinkRoutes } from './customer-email-link.routes';
import { deriveEmailAuthSourceKey, resolveEmailAuthConfig } from './customer-email-auth.config';
import { customerChallengeDigest } from './customer-email-challenge-digest';
import { logEmailAuthUnavailable } from './customer-email-auth.diagnostics';

export type CustomerEmailLinkRuntime = {
  dependencies: Parameters<typeof createIsolatedCustomerEmailLinkRoutes>[0];
  close(): Promise<void>;
};

/** Separate composition for the pre-existing S3 service; it never enters the registration/login composition. */
export function createCustomerEmailLinkComposition(options: {
  isEnabled: (c: Context) => boolean;
  open: (c: Context) => Promise<CustomerEmailLinkRuntime | null>;
}) {
  const app = new Hono();
  app.all('/email/link/*', async (c) => {
    if (!options.isEnabled(c)) return c.json({ error: 'Not Found' }, 404);
    let runtime: CustomerEmailLinkRuntime | null;
    try {
      runtime = await options.open(c);
    } catch (error) {
      logEmailAuthUnavailable('runtime_open_failed', { surface: 'runtime', error });
      runtime = null;
    }
    if (!runtime) return c.json({ error: 'Service unavailable' }, 503);
    try {
      const url = new URL(c.req.url);
      url.pathname = url.pathname.slice(url.pathname.indexOf('/email/link/'));
      const inner = createIsolatedCustomerEmailLinkRoutes(runtime.dependencies);
      return await inner.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
    } finally {
      await runtime.close();
    }
  });
  return app;
}

export async function openCustomerEmailLinkRuntime(c: Context): Promise<CustomerEmailLinkRuntime | null> {
  const env = c.env as Bindings;
  const resolved = resolveEmailAuthConfig(env);
  if (!resolved.ok) {
    logEmailAuthUnavailable('config_incomplete', { surface: 'runtime', missing: resolved.missing });
    return null;
  }
  const { db, close } = await createDb(env.HYPERDRIVE);
  const { config } = resolved;
  const hasher = createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER);
  const email = createAccountSecurityEmailService(env.ENVIRONMENT, {
    apiKey: env.RESEND_API_KEY,
    fromAddress: env.RESEND_FROM_ADDRESS,
  });
  const source = createCustomerEmailTrustedSource({
    ...(env.CLIENT_ATTRIBUTION_SECRET ? { attributionSecret: env.CLIENT_ATTRIBUTION_SECRET } : {}),
    ...(env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS ? { previousAttributionSecret: env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS } : {}),
    sourceKeySecret: await deriveEmailAuthSourceKey(config.hmacSecret),
  });
  return {
    dependencies: {
      sessions: new CustomerSessionService(db, config.session),
      link: createCustomerEmailLinkService({
        db,
        hmacSecret: config.hmacSecret,
        hasher,
        passwordPolicy: { minLength: config.passwordMinLength },
        deliver: createEmailLinkProofDelivery({ email, webBaseUrl: config.webBaseUrl }),
      }),
      limiter: {
        resolveTrustedSource: source,
        keyForIdentifier: (address) => customerChallengeDigest({
          secret: config.hmacSecret,
          purpose: 'email_link',
          field: 'subject',
          value: address,
        }),
        limit: createSharedEmailAuthLimiter(env.CUSTOMER_AUTH_RATE_LIMIT),
      },
    },
    close,
  };
}

export const customerEmailLinkComposition = createCustomerEmailLinkComposition({
  isEnabled: (c) => {
    const env = c.env as Bindings;
    return env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true' && env.CUSTOMER_LEGACY_UPGRADE_ENABLED === 'true';
  },
  open: openCustomerEmailLinkRuntime,
});
