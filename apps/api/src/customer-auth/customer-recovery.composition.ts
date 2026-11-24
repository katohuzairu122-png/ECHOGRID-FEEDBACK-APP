import { createRecoveryCodeManagementLimiter } from './customer-recovery-code-management';
import type { Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createDurableObjectPbkdf2Worker } from '../auth/pbkdf2-worker';
import { createAccountSecurityEmailService } from '../notifications/email.service';
import { CustomerCredentialRepository } from '../repositories/customer-credential.repository';
import { CustomerRepository } from '../repositories/customer.repository';
import { CustomerSessionService } from './customer-session.service';
import { CustomerPasswordAuthService } from './customer-password-auth.service';
import { createCustomerRecoveryCodeService } from './customer-recovery-code.service';
import { createSmsService } from './sms.service';
import { normalizeLoginEmail } from './customer-email-challenge-digest';
import { createCustomerEmailTrustedSource } from './customer-email-trusted-source';
import { createSharedEmailAuthLimiter } from './customer-email-rate-limit';
import { resolveEmailAuthConfig } from './customer-email-auth.config';
import { resolveCustomerRecoverySecret } from './customer-recovery-config';
import { createCustomerRecoveryService } from './customer-recovery-attempt.service';
import {
  createRecoveryEmailChallengeDelivery,
  createRecoveryNotifier,
  createRecoveryPhoneOtp,
} from './customer-recovery-delivery';
import { createCustomerRecoveryRoutes } from './customer-recovery.routes';

/**
 * CUSTOMER-AUTH-S4-03 composition root. The ONLY place that turns Worker bindings into the
 * recovery services, and only after the gate is on.
 *
 * Nothing is invented: every dependency is an existing binding or abstraction, and a missing
 * one makes recovery unavailable (503) instead of falling back. Required to activate (none of
 * which this code creates): CUSTOMER_RECOVERY_ENABLED="true", the dedicated
 * CUSTOMER_RECOVERY_HMAC_SECRET, CUSTOMER_PASSWORD_MIN_LENGTH (owner decision CA-05, approved: 8),
 * the CustomerEmailRateLimit Durable Object namespace as CUSTOMER_AUTH_RATE_LIMIT,
 * CLIENT_ATTRIBUTION_SECRET (so the Web Worker's signature can be verified), WEB_BASE_URL,
 * RESEND_*, TWILIO_* and TWILIO_VERIFY_SERVICE_SID.
 */
export const isCustomerRecoveryEnabled = (env: Bindings): boolean =>
  env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true' && env.CUSTOMER_RECOVERY_ENABLED === 'true';

const encoder = new TextEncoder();

/** A source-keying secret derived from the dedicated recovery secret (no extra secret to provision, domain-separated). */
async function deriveSourceKeySecret(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode('echo-grid/customer-recovery/v1/source-key'),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `CUSTOMER_PASSWORD_MIN_LENGTH` as a strict positive integer, or null. There is no default. */
export function parsePasswordMinLength(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]{1,3}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

function webBaseUrlOf(env: Bindings): string | null {
  try {
    const url = new URL(env.WEB_BASE_URL);
    return url.protocol === 'https:' || url.hostname === 'localhost' ? url.origin : null;
  } catch {
    return null;
  }
}

export async function resolveRecoveryTrustedSource(c: Context): Promise<string | null> {
  const env = c.env as Bindings;
  try {
    const secret = resolveCustomerRecoverySecret(env as unknown as Record<string, unknown>);
    return await createCustomerEmailTrustedSource({
      ...(env.CLIENT_ATTRIBUTION_SECRET
        ? { attributionSecret: env.CLIENT_ATTRIBUTION_SECRET }
        : {}),
      ...(env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS
        ? { previousAttributionSecret: env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS }
        : {}),
      sourceKeySecret: await deriveSourceKeySecret(secret),
    })(c.req.raw);
  } catch {
    return null;
  }
}

export async function openRecoveryDependencies(c: Context) {
  const env = c.env as Bindings;
  const secret = resolveCustomerRecoverySecret(env as unknown as Record<string, unknown>);
  const emailAuth = resolveEmailAuthConfig(env);
  const minLength = parsePasswordMinLength(env.CUSTOMER_PASSWORD_MIN_LENGTH);
  const webBaseUrl = webBaseUrlOf(env);
  if (
    !emailAuth.ok ||
    minLength === null ||
    webBaseUrl === null ||
    !env.HYPERDRIVE ||
    !env.PASSWORD_HASHER
  )
    return null;

  const { db, close } = await createDb(env.HYPERDRIVE);
  try {
    const email = createAccountSecurityEmailService(env.ENVIRONMENT, {
      apiKey: env.RESEND_API_KEY,
      fromAddress: env.RESEND_FROM_ADDRESS,
    });
    const sms = createSmsService(env.ENVIRONMENT, {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      fromNumber: env.TWILIO_FROM_NUMBER,
    });
    const hasher = createDurableObjectPbkdf2Worker(env.PASSWORD_HASHER);
    const service = createCustomerRecoveryService({
      db,
      hmacSecret: secret,
      hasher,
      passwordPolicy: { minLength },
      limiter: createSharedEmailAuthLimiter(env.CUSTOMER_AUTH_RATE_LIMIT),
      notifier: createRecoveryNotifier({ email, sms, webBaseUrl }),
      deliverEmailChallenge: createRecoveryEmailChallengeDelivery({ email, webBaseUrl }),
      phoneOtp: createRecoveryPhoneOtp({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        serviceSid: env.TWILIO_VERIFY_SERVICE_SID,
      }),
      phoneProofMaxAgeSeconds: 300,
    });
    const sessions = new CustomerSessionService(db, emailAuth.config.session);
    const passwordAuth = new CustomerPasswordAuthService(db, sessions, hasher, {
      passwordMinLength: minLength,
      phoneProofMaxAgeSeconds: 300,
    });
    const recoveryCodes = createCustomerRecoveryCodeService({
      db,
      hmacSecret: secret,
      stepUpWindowSeconds: emailAuth.config.session.stepUpWindowSeconds,
    });
    const rateLimit = createSharedEmailAuthLimiter(env.CUSTOMER_AUTH_RATE_LIMIT);
    const allowCodeManagement = createRecoveryCodeManagementLimiter(secret, rateLimit);
    return {
      deps: {
        service,
        findCustomerIdByLoginEmail: async (address: string) => {
          const normalized = normalizeLoginEmail(address);
          if (!normalized) return null;
          const credential = await new CustomerCredentialRepository(db).findByLoginEmail(
            normalized,
          );
          return credential?.loginEmailVerifiedAt ? credential.customerId : null;
        },
        findCustomerIdByVerifiedPhone: async (phone: string) => {
          const customer = await new CustomerRepository(db).findVerifiedByPhone(phone);
          if (!customer) return null;
          const credential = await new CustomerCredentialRepository(db).findByCustomerId(
            customer.id,
          );
          return credential?.loginEmailVerifiedAt ? customer.id : null;
        },
        codeManagement: {
          authenticate: async (token: string) => {
            const identity = await sessions.authenticateSessionToken(token);
            return identity?.assurance === 'session' ? identity : null;
          },
          reauthenticate: ({
            customerId,
            sessionId,
            currentPassword,
          }: {
            customerId: string;
            sessionId: string;
            currentPassword: string;
          }) => passwordAuth.reauthenticateSession({ customerId, sessionId, currentPassword }),
          allow: allowCodeManagement,
          issue: (owner: { customerId: string; sessionId: string }) => recoveryCodes.issue(owner),
          revoke: (owner: { customerId: string; sessionId: string }) => recoveryCodes.revoke(owner),
        },
      },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** The router mounted by the API. Disabled (generic 404) unless `CUSTOMER_RECOVERY_ENABLED` is exactly "true". */
export const customerRecoveryRoutes = createCustomerRecoveryRoutes({
  isEnabled: (c) => isCustomerRecoveryEnabled(c.env as Bindings),
  resolveTrustedSource: resolveRecoveryTrustedSource,
  open: openRecoveryDependencies,
});
