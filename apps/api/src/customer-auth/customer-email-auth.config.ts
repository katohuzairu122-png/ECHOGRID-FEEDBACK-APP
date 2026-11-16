import type { Bindings } from '../config/env';
import type { CustomerSessionServiceConfig } from './customer-session.service';

/**
 * CUSTOMER-AUTH-S5-01: configuration for email registration and login.
 *
 * Nothing is defaulted. Every value that is an owner decision (session lifetimes CA-02, password minimum CA-05) or a
 * secret must be supplied by the environment; a missing, malformed or reused value makes the feature unavailable
 * (503) instead of falling back. Secrets are never logged and never echoed in an error: `missing` names settings only.
 *
 * Required to activate (none of which this code creates):
 *   CUSTOMER_EMAIL_AUTH_ENABLED="true"
 *   CUSTOMER_EMAIL_AUTH_HMAC_SECRET       dedicated, >= 32 bytes, used for proof and identifier digests
 *   CUSTOMER_SESSION_SIGNING_SECRET       dedicated, >= 32 bytes, signs session access tokens (never the legacy JWT secret)
 *   CUSTOMER_SESSION_ACCESS_TTL_SECONDS, CUSTOMER_SESSION_REFRESH_TTL_SECONDS, CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS,
 *   CUSTOMER_SESSION_IDLE_TTL_SECONDS, CUSTOMER_STEP_UP_WINDOW_SECONDS   (owner decision CA-02, no defaults)
 *   CUSTOMER_PASSWORD_MIN_LENGTH          (owner decision CA-05, no default)
 *   CUSTOMER_AUTH_RATE_LIMIT              Durable Object namespace bound to CustomerEmailRateLimit
 *   CLIENT_ATTRIBUTION_SECRET             so the Web Worker's signature on each request can be verified
 *   WEB_BASE_URL (https, or localhost), HYPERDRIVE, PASSWORD_HASHER, RESEND_* for proof delivery
 */
export const isCustomerEmailAuthEnabled = (env: { CUSTOMER_EMAIL_AUTH_ENABLED?: string | undefined }): boolean =>
  env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true';

const MIN_SECRET_BYTES = 32;
const encoder = new TextEncoder();

export const EMAIL_AUTH_HMAC_SECRET_NAME = 'CUSTOMER_EMAIL_AUTH_HMAC_SECRET';
export const SESSION_SIGNING_SECRET_NAME = 'CUSTOMER_SESSION_SIGNING_SECRET';

/** A strict positive integer string (no sign, no decimals, no exponent, at most 9 digits), or null. */
export function parsePositiveIntSetting(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) return null;
  return Number(value);
}

/** True when `value` is a usable dedicated secret: a long-enough string that no OTHER secret-like binding shares. */
function dedicatedSecret(env: Record<string, unknown>, name: string): string | null {
  const secret = env[name];
  if (typeof secret !== 'string' || encoder.encode(secret).length < MIN_SECRET_BYTES) return null;
  for (const [other, value] of Object.entries(env)) {
    if (other === name) continue;
    if (typeof value === 'string' && /SECRET|KEY|TOKEN/i.test(other) && value === secret) return null;
  }
  return secret;
}

export type ResolvedEmailAuthConfig = {
  hmacSecret: string;
  passwordMinLength: number;
  webBaseUrl: string;
  session: CustomerSessionServiceConfig;
};

export type EmailAuthConfigResult =
  | { ok: true; config: ResolvedEmailAuthConfig }
  | { ok: false; missing: string[] };

function webBaseUrlOf(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.hostname === 'localhost' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Resolves and validates every setting. Returns the names of whatever is missing or unusable (never a value). The
 * session lifetimes must also be coherent: access < refresh <= absolute and idle <= absolute.
 */
export function resolveEmailAuthConfig(env: Bindings): EmailAuthConfigResult {
  const raw = env as unknown as Record<string, unknown>;
  const missing: string[] = [];

  const hmacSecret = dedicatedSecret(raw, EMAIL_AUTH_HMAC_SECRET_NAME);
  if (!hmacSecret) missing.push(EMAIL_AUTH_HMAC_SECRET_NAME);

  const sessionSecret = dedicatedSecret(raw, SESSION_SIGNING_SECRET_NAME);
  if (!sessionSecret) missing.push(SESSION_SIGNING_SECRET_NAME);
  // The two dedicated secrets must also differ from each other (dedicatedSecret already rejects any equal binding).

  const ttl = (name: keyof Bindings) => {
    const parsed = parsePositiveIntSetting(raw[name as string]);
    if (parsed === null) missing.push(String(name));
    return parsed;
  };
  const accessTtlSeconds = ttl('CUSTOMER_SESSION_ACCESS_TTL_SECONDS');
  const refreshTtlSeconds = ttl('CUSTOMER_SESSION_REFRESH_TTL_SECONDS');
  const absoluteTtlSeconds = ttl('CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS');
  const idleTtlSeconds = ttl('CUSTOMER_SESSION_IDLE_TTL_SECONDS');
  const stepUpWindowSeconds = ttl('CUSTOMER_STEP_UP_WINDOW_SECONDS');
  const passwordMinLength = ttl('CUSTOMER_PASSWORD_MIN_LENGTH');

  if (
    accessTtlSeconds !== null && refreshTtlSeconds !== null && absoluteTtlSeconds !== null && idleTtlSeconds !== null &&
    !(accessTtlSeconds < refreshTtlSeconds && refreshTtlSeconds <= absoluteTtlSeconds && idleTtlSeconds <= absoluteTtlSeconds)
  ) {
    missing.push('CUSTOMER_SESSION_*_TTL_SECONDS (incoherent: need access < refresh <= absolute and idle <= absolute)');
  }

  const webBaseUrl = webBaseUrlOf(raw.WEB_BASE_URL);
  if (!webBaseUrl) missing.push('WEB_BASE_URL');
  if (!raw.HYPERDRIVE) missing.push('HYPERDRIVE');
  if (!raw.PASSWORD_HASHER) missing.push('PASSWORD_HASHER');
  if (!raw.CUSTOMER_AUTH_RATE_LIMIT) missing.push('CUSTOMER_AUTH_RATE_LIMIT');
  if (typeof raw.CLIENT_ATTRIBUTION_SECRET !== 'string' || raw.CLIENT_ATTRIBUTION_SECRET.length === 0) {
    missing.push('CLIENT_ATTRIBUTION_SECRET');
  }
  if (typeof raw.CUSTOMER_JWT_SECRET !== 'string' || raw.CUSTOMER_JWT_SECRET.length === 0) missing.push('CUSTOMER_JWT_SECRET');

  if (
    missing.length > 0 || !hmacSecret || !sessionSecret || accessTtlSeconds === null || refreshTtlSeconds === null ||
    absoluteTtlSeconds === null || idleTtlSeconds === null || stepUpWindowSeconds === null ||
    passwordMinLength === null || !webBaseUrl
  ) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    config: {
      hmacSecret,
      passwordMinLength,
      webBaseUrl,
      session: {
        sessionSigningSecret: sessionSecret,
        legacySigningSecret: raw.CUSTOMER_JWT_SECRET as string,
        legacyAccepted: () => true, // the legacy 90-day token path is unchanged by this feature
        accessTtlSeconds,
        refreshTtlSeconds,
        absoluteTtlSeconds,
        idleTtlSeconds,
        stepUpWindowSeconds,
      },
    },
  };
}

/** A source-keying secret derived from the dedicated HMAC secret (domain-separated, no extra secret to provision). */
export async function deriveEmailAuthSourceKey(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode('echo-grid/customer-email-auth/v1/source-key'));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}
