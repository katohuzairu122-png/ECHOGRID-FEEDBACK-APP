import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createDurableObjectPbkdf2Worker } from '../auth/pbkdf2-worker';
import { createAccountSecurityEmailService } from '../notifications/email.service';
import { createCustomerEmailTrustedSource } from './customer-email-trusted-source';
import { createSharedEmailAuthLimiter } from './customer-email-rate-limit';
import { createEmailRegistrationService } from './customer-email-auth.service';
import { createCustomerEmailLinkService } from './customer-email-link.service';
import { createRegistrationProofDelivery, createEmailLinkProofDelivery } from './customer-email-auth.delivery';
import { createIsolatedCustomerEmailAuthRoutes, type IsolatedEmailAuthDependencies } from './customer-email-auth.routes';
import { customerChallengeDigest } from './customer-email-challenge-digest';
import { CustomerSessionService } from './customer-session.service';
import { logEmailAuthUnavailable } from './customer-email-auth.diagnostics';
import { CustomerPasswordAuthService } from './customer-password-auth.service';
import { CustomerRepository } from '../repositories/customer.repository';
import { createRepositories } from '../repositories';
import { CustomerAuthService } from './customer-auth.service';
import { createSmsService } from './sms.service';
import { TwilioVerifyService } from './twilio-verify.service';
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
    } catch (error) {
      logEmailAuthUnavailable('runtime_open_failed', { surface: 'runtime', error });
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
  deliverLink?: Parameters<typeof createCustomerEmailLinkService>[0]['deliver'];
  verifyPhoneOtp?: (db: Database, phone: string, code: string) => Promise<boolean>;
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
    requestProof: (address, next, signup) => parts.withDb((db) => registration(db).requestProof(address, next, signup)),
    completeRegistration: (input) => parts.withDb(async (db) => {
      const completed = await registration(db).completeRegistration(input);
      if (!completed.ok) return completed;
      // A verified proof creates an account and an immediately usable rotating session.
      const sessions = new CustomerSessionService(db, config.session);
      const established = await sessions.establishSession({ customerId: completed.customerId, authMethod: 'password' });
      return established.ok ? { ...completed, session: established.session } : completed;
    }),
    login: (input) =>
      parts.withDb((db) => {
        const sessions = new CustomerSessionService(db, config.session);
        return new CustomerPasswordAuthService(db, sessions, parts.hasher, {
          passwordMinLength: config.passwordMinLength,
          phoneProofMaxAgeSeconds: 300,
        }).loginWithVerifiedEmailPassword({ email: input.email, password: input.password });
      }),
    legacyOtpSession: (phone, code) => parts.withDb(async (db) => {
      if (!parts.verifyPhoneOtp || !await parts.verifyPhoneOtp(db, phone, code)) return null;
      // Only the verified phone owner can reuse the original customer ID.
      const found = await new CustomerRepository(db).createIfAbsent({ phone, phoneVerifiedAt: new Date() });
      if (!found.customer) return null;
      const sessions = new CustomerSessionService(db, config.session);
      const established = await sessions.establishSession({ customerId: found.customer.id, authMethod: 'otp' });
      return established.ok ? established.session : null; // linked-email customers have OTP retired.
    }),
    requestLink: (token, email) => parts.withDb(async (db) => {
      const sessions = new CustomerSessionService(db, config.session);
      const identity = await sessions.authenticateSessionToken(token);
      if (!identity || identity.assurance !== 'session' || identity.authMethod !== 'otp') return false;
      const links = createCustomerEmailLinkService({
        db, hmacSecret: config.hmacSecret, hasher: parts.hasher,
        passwordPolicy: { minLength: config.passwordMinLength },
        ...(parts.deliverLink ? { deliver: parts.deliverLink } : {}),
      });
      await links.requestProof({ customerId: identity.customerId, sessionId: identity.sessionId }, email);
      return true;
    }),
    completeLink: (token, input) => parts.withDb(async (db) => {
      const sessions = new CustomerSessionService(db, config.session);
      const identity = await sessions.authenticateSessionToken(token);
      if (!identity || identity.assurance !== 'session' || identity.authMethod !== 'otp') return false;
      const links = createCustomerEmailLinkService({
        db, hmacSecret: config.hmacSecret, hasher: parts.hasher,
        passwordPolicy: { minLength: config.passwordMinLength },
      });
      return links.complete({ customerId: identity.customerId, sessionId: identity.sessionId }, input);
    }),
    changePassword: async (accessToken, input) => parts.withDb(async (db) => {
      const sessions = new CustomerSessionService(db, config.session);
      const identity = await sessions.authenticateSessionToken(accessToken);
      if (!identity || identity.assurance !== 'session') return false;
      const result = await new CustomerPasswordAuthService(db, sessions, parts.hasher, {
        passwordMinLength: config.passwordMinLength,
        phoneProofMaxAgeSeconds: 300,
      }).changePassword({
        customerId: identity.customerId,
        sessionId: identity.sessionId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      });
      return result.ok;
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
  if (!resolved.ok) {
    logEmailAuthUnavailable('config_incomplete', { surface: 'runtime', missing: resolved.missing });
    return null;
  }
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
    deliverLink: createEmailLinkProofDelivery({ email, webBaseUrl: config.webBaseUrl }),
    verifyPhoneOtp: async (db, phone, code) => {
      if (env.ENVIRONMENT === 'production') {
        return new TwilioVerifyService({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          serviceSid: env.TWILIO_VERIFY_SERVICE_SID,
        }).check(phone, code);
      }
      const service = new CustomerAuthService(
        createRepositories(db),
        createSmsService(env.ENVIRONMENT, {
          accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber: env.TWILIO_FROM_NUMBER,
        }),
        { CUSTOMER_JWT_SECRET: env.CUSTOMER_JWT_SECRET },
        createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER),
      );
      await service.consumeOtp(phone, code);
      return true;
    },
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
