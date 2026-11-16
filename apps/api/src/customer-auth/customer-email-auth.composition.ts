import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createDurableObjectPbkdf2Worker } from '../auth/pbkdf2-worker';
import { createAccountSecurityEmailService } from '../notifications/email.service';
import { createCustomerEmailTrustedSource } from './customer-email-trusted-source';
import { createSharedEmailAuthLimiter } from './customer-email-rate-limit';
import { createEmailRegistrationService } from './customer-email-auth.service';
import { createRegistrationProofDelivery } from './customer-email-auth.delivery';
import { createIsolatedCustomerEmailAuthRoutes, type IsolatedEmailAuthDependencies } from './customer-email-auth.routes';
import { customerChallengeDigest } from './customer-email-challenge-digest';
import { CustomerSessionService } from './customer-session.service';
import { CustomerPasswordAuthService } from './customer-password-auth.service';
import {
  type ResolvedEmailAuthConfig,
  deriveEmailAuthSourceKey,
  isCustomerEmailAuthEnabled,
  resolveEmailAuthConfig,
} from './customer-email-auth.config';

/**
 * CUSTOMER-AUTH-S5-01 composition root for email registration and login.
 *
 * Disabled (the same generic 404 as an unmounted path) unless CUSTOMER_EMAIL_AUTH_ENABLED is exactly "true". When on,
 * a missing or unusable setting answers a generic 503: there is no fallback, no default and nothing is invented. Every
 * request must carry the Web Worker's signed attribution (the isolated routes deny anything else), so only the Web
 * Worker, never a browser, can reach these endpoints. Login returns the rotating session credentials to that Web
 * Worker, which keeps them in host-only HttpOnly cookies (a later stage); no credential is ever logged.
 */
export type EmailAuthRuntime = {
  dependencies: IsolatedEmailAuthDependencies;
  /** Closes every database connection opened while serving this request. */
  close(): Promise<void>;
};

export function createCustomerEmailAuthComposition(options: {
  isEnabled: (c: Context) => boolean;
  /** Returns null when the feature cannot run (any setting missing): the caller answers 503. */
  open: (c: Context) => Promise<EmailAuthRuntime | null>;
}) {
  const app = new Hono();
  app.all('/email/*', async (c) => {
    if (!options.isEnabled(c)) return c.json({ error: 'Not Found' }, 404);
    let runtime: EmailAuthRuntime | null = null;
    try {
      runtime = await options.open(c);
    } catch {
      runtime = null;
    }
    if (!runtime) return c.json({ error: 'Service unavailable' }, 503);
    try {
      // The isolated router owns the /email/... paths; strip any mount prefix so it matches wherever this is mounted.
      const url = new URL(c.req.url);
      url.pathname = url.pathname.slice(url.pathname.indexOf('/email/'));
      const inner = createIsolatedCustomerEmailAuthRoutes(runtime.dependencies);
      return await inner.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
    } finally {
      c.executionCtx.waitUntil(runtime.close());
    }
  });
  return app;
}

/** The parts that differ between the Worker and a test. Everything else (the wiring) is shared and therefore tested. */
export type EmailAuthParts = {
  withDb: <T>(fn: (db: Database) => Promise<T>) => Promise<T>;
  hasher: Parameters<typeof createEmailRegistrationService>[0]['hasher'];
  deliver: Parameters<typeof createEmailRegistrationService>[0]['deliver'];
  limit: IsolatedEmailAuthDependencies['limit'];
  resolveTrustedSource: IsolatedEmailAuthDependencies['resolveTrustedSource'];
};

/** The one place that turns validated config and parts into the isolated routes' dependencies. */
export function createEmailAuthDependencies(config: ResolvedEmailAuthConfig, parts: EmailAuthParts): IsolatedEmailAuthDependencies {
  const registration = (db: Database) =>
    createEmailRegistrationService({
      db,
      hmacSecret: config.hmacSecret,
      passwordPolicy: { minLength: config.passwordMinLength },
      hasher: parts.hasher,
      deliver: parts.deliver,
    });
  return {
    resolveTrustedSource: parts.resolveTrustedSource,
    keyForIdentifier: (address) =>
      customerChallengeDigest({ secret: config.hmacSecret, purpose: 'email_registration', field: 'subject', value: address }),
    limit: parts.limit,
    requestProof: (address) => parts.withDb((db) => registration(db).requestProof(address)),
    completeRegistration: (input) => parts.withDb((db) => registration(db).completeRegistration(input)),
    login: (input) =>
      parts.withDb((db) => {
        const sessions = new CustomerSessionService(db, config.session);
        return new CustomerPasswordAuthService(db, sessions, parts.hasher, {
          passwordMinLength: config.passwordMinLength,
          phoneProofMaxAgeSeconds: 300,
        }).loginWithVerifiedEmailPassword({ email: input.email, password: input.password });
      }),
    transportSession: (session) =>
      Response.json(
        {
          accessToken: session.accessToken,
          accessExpiresAt: session.accessExpiresAt.toISOString(),
          refreshCredential: session.refreshCredential,
          refreshExpiresAt: session.refreshExpiresAt.toISOString(),
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      ),
  };
}

/** Builds the real dependencies from Worker bindings. Returns null (-> 503) unless every setting is present and valid. */
export async function openEmailAuthRuntime(c: Context): Promise<EmailAuthRuntime | null> {
  const env = c.env as Bindings;
  const resolved = resolveEmailAuthConfig(env);
  if (!resolved.ok) return null;
  const { config } = resolved;

  const closers: Array<() => Promise<void>> = [];
  const withDb = async <T>(fn: (db: Database) => Promise<T>): Promise<T> => {
    const { db, close } = await createDb(env.HYPERDRIVE);
    closers.push(close);
    return fn(db);
  };
  const email = createAccountSecurityEmailService(env.ENVIRONMENT, {
    apiKey: env.RESEND_API_KEY,
    fromAddress: env.RESEND_FROM_ADDRESS,
  });
  const dependencies = createEmailAuthDependencies(config, {
    withDb,
    hasher: createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER),
    deliver: createRegistrationProofDelivery({ email, webBaseUrl: config.webBaseUrl }),
    limit: createSharedEmailAuthLimiter(env.CUSTOMER_AUTH_RATE_LIMIT),
    resolveTrustedSource: createCustomerEmailTrustedSource({
      ...(env.CLIENT_ATTRIBUTION_SECRET ? { attributionSecret: env.CLIENT_ATTRIBUTION_SECRET } : {}),
      ...(env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS ? { previousAttributionSecret: env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS } : {}),
      sourceKeySecret: await deriveEmailAuthSourceKey(config.hmacSecret),
    }),
  });
  return { dependencies, close: async () => { await Promise.allSettled(closers.map((close) => close())); } };
}

/** The router mounted by the API. Generic 404 unless CUSTOMER_EMAIL_AUTH_ENABLED is exactly "true". */
export const customerEmailAuthComposition = createCustomerEmailAuthComposition({
  isEnabled: (c) => isCustomerEmailAuthEnabled(c.env as Bindings),
  open: openEmailAuthRuntime,
});
