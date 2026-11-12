import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors';

/**
 * CUSTOMER-AUTH-01D-5: rate limiting for the customer authentication surfaces
 * (CUSTOMER_AUTH_01A section 6.4).
 *
 * NOT applied to any route yet and NO limiter binding is declared in
 * wrangler.toml: namespace ids must be unique across the Cloudflare account and
 * the budgets are owner cost decisions (see
 * docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_01D5_RATE_LIMITS.md).
 * Every binding below is OPTIONAL in the environment type, and the checker
 * FAILS CLOSED when one is missing, so a route that forgets its limiter is
 * denied rather than silently unthrottled.
 *
 * What this fixes in the current OTP limiter:
 *  - request and verify no longer share one budget (A4), because every surface
 *    has its own bindings;
 *  - an input with no usable phone no longer falls into one shared
 *    `phone:invalid` bucket that anyone could exhaust for everyone: that
 *    dimension is simply skipped;
 *  - the SMS-cost ceiling is a separate GLOBAL dimension, and the per-source
 *    dimension stops one source rotating through many phone numbers (T5);
 *  - phone numbers never appear in a limiter key, only a SHA-256 prefix.
 *
 * Design limits, stated plainly: Cloudflare counts every call, successful or
 * not, in a fixed window, so this THROTTLES and never locks an account for
 * longer than the window. An attacker can therefore still hold one phone's
 * dimension saturated while they keep sending (T4), but cannot lock it beyond
 * the window, and the source and phone+source dimensions are what limit them.
 */

export type CustomerAuthSurface =
  | 'otp_request'
  | 'otp_verify'
  | 'password_login'
  | 'password_recovery'
  | 'session_refresh'
  | 'password_change';

export type CustomerAuthDimension = 'phone' | 'source' | 'phone_source' | 'global' | 'customer';

/** Which dimensions each surface enforces, in the order they are reported. */
export const CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS: Record<
  CustomerAuthSurface,
  readonly CustomerAuthDimension[]
> = {
  otp_request: ['phone', 'source', 'global'],
  otp_verify: ['phone', 'source'],
  password_login: ['phone', 'source', 'phone_source'],
  password_recovery: ['phone', 'source'],
  session_refresh: ['source'],
  password_change: ['customer'],
};

/**
 * What to do when a limiter is missing or errors. Surfaces that cost money or
 * guard a guessable secret fail CLOSED. Refresh fails OPEN: its credential is
 * 256 random bits (nothing to guess) and a limiter outage must not sign every
 * customer out.
 */
export const CUSTOMER_AUTH_ON_LIMITER_ERROR: Record<CustomerAuthSurface, 'deny' | 'allow'> = {
  otp_request: 'deny',
  otp_verify: 'deny',
  password_login: 'deny',
  password_recovery: 'deny',
  session_refresh: 'allow',
  password_change: 'deny',
};

export function limiterBindingName(
  surface: CustomerAuthSurface,
  dimension: CustomerAuthDimension,
): string {
  return `CUSTOMER_AUTH_RL_${surface.toUpperCase()}_${dimension.toUpperCase()}`;
}

export type RateLimiterLike = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type RateLimitSubject = {
  /** A candidate phone. Used only if it is valid E.164. Never placed in a key as-is. */
  phone?: unknown;
  /** The client network source. Skipped when absent: there is NO shared "unknown" bucket. */
  source?: string | null | undefined;
  customerId?: string | null | undefined;
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: 'limited'; dimension: CustomerAuthDimension }
  | { allowed: false; reason: 'unavailable'; dimension: CustomerAuthDimension };

const PHONE_FORMAT = /^\+[1-9][0-9]{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SOURCE_LENGTH = 64;

async function sha256Prefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function keyFor(
  surface: CustomerAuthSurface,
  dimension: CustomerAuthDimension,
  subject: RateLimitSubject,
): Promise<string | null> {
  const phone =
    typeof subject.phone === 'string' && PHONE_FORMAT.test(subject.phone.trim())
      ? subject.phone.trim()
      : null;
  const source =
    subject.source && subject.source.length <= MAX_SOURCE_LENGTH ? subject.source : null;
  const customerId =
    subject.customerId && UUID.test(subject.customerId) ? subject.customerId.toLowerCase() : null;
  const prefix = `ca:${surface}:${dimension}:`;
  switch (dimension) {
    case 'phone':
      return phone ? prefix + (await sha256Prefix(phone)) : null;
    case 'source':
      return source ? prefix + source : null;
    case 'phone_source':
      return phone && source ? prefix + (await sha256Prefix(`${phone}|${source}`)) : null;
    case 'customer':
      return customerId ? prefix + customerId : null;
    case 'global':
      return prefix + 'all';
  }
}

/**
 * Checks every applicable dimension of a surface. All applicable limiters are
 * called (not short-circuited) so every dimension's counter reflects the
 * attempt. A dimension whose subject is missing is skipped.
 */
export async function checkCustomerAuthRateLimit(
  env: Record<string, unknown>,
  surface: CustomerAuthSurface,
  subject: RateLimitSubject,
): Promise<RateLimitDecision> {
  const onError = CUSTOMER_AUTH_ON_LIMITER_ERROR[surface];
  const results: Array<{ dimension: CustomerAuthDimension; outcome: 'ok' | 'limited' | 'error' }> =
    [];

  await Promise.all(
    CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS[surface].map(async (dimension) => {
      const key = await keyFor(surface, dimension, subject);
      if (key === null) return; // nothing to key on: skip, never share a bucket
      const limiter = env[limiterBindingName(surface, dimension)] as RateLimiterLike | undefined;
      if (!limiter || typeof limiter.limit !== 'function') {
        results.push({ dimension, outcome: 'error' });
        return;
      }
      try {
        const { success } = await limiter.limit({ key });
        results.push({ dimension, outcome: success ? 'ok' : 'limited' });
      } catch {
        results.push({ dimension, outcome: 'error' });
      }
    }),
  );

  const order = CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS[surface];
  const sorted = [...results].sort(
    (a, b) => order.indexOf(a.dimension) - order.indexOf(b.dimension),
  );
  const limited = sorted.find((r) => r.outcome === 'limited');
  if (limited) return { allowed: false, reason: 'limited', dimension: limited.dimension };
  const errored = sorted.find((r) => r.outcome === 'error');
  if (errored && onError === 'deny')
    return { allowed: false, reason: 'unavailable', dimension: errored.dimension };
  return { allowed: true };
}

/** Reads a candidate phone from a JSON or form body WITHOUT consuming the request the handler will read. */
export async function readPhoneFromRequest(request: Request): Promise<string | null> {
  try {
    const clone = request.clone();
    const type = clone.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const body = (await clone.json()) as { phone?: unknown } | null;
      return typeof body?.phone === 'string' ? body.phone : null;
    }
    if (type.includes('application/x-www-form-urlencoded')) {
      const phone = new URLSearchParams(await clone.text()).get('phone');
      return phone;
    }
  } catch {
    /* an unreadable body just means no phone dimension */
  }
  return null;
}

export type CustomerAuthRateLimitOptions = {
  resolveSubject?: (request: Request) => Promise<RateLimitSubject> | RateLimitSubject;
  /** Observability hook. Receives the surface and decision, never the phone or any key. */
  onDecision?: (surface: CustomerAuthSurface, decision: RateLimitDecision) => void;
};

/**
 * Hono middleware. Denials are ONE generic response: the dimension that tripped
 * is never revealed to the caller, and no audit row is written per denial
 * (that would let an attacker grow the table by being throttled).
 */
export function customerAuthRateLimit(
  surface: CustomerAuthSurface,
  options: CustomerAuthRateLimitOptions = {},
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const subject = options.resolveSubject
      ? await options.resolveSubject(c.req.raw)
      : {
          phone: await readPhoneFromRequest(c.req.raw),
          source: c.req.header('cf-connecting-ip') ?? null,
        };
    const decision = await checkCustomerAuthRateLimit(
      c.env as Record<string, unknown>,
      surface,
      subject,
    );
    options.onDecision?.(surface, decision);
    if (decision.allowed) return next();
    if (decision.reason === 'unavailable') {
      throw new AppError(
        'Service temporarily unavailable. Please try again shortly.',
        503,
        'RATE_LIMIT_UNAVAILABLE',
      );
    }
    throw new AppError('Too many requests. Please try again shortly.', 429, 'RATE_LIMITED');
  });
}
