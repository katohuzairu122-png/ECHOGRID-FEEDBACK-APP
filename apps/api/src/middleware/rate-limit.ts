import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { resolveClient } from '../lib/client-attribution';
import type { CustomerAuthVariables } from './customer-authenticate';

/**
 * Thin wrapper around Cloudflare's native Rate Limiting binding
 * (env.<name>.limit()) -- not Durable Objects, which the original roadmap
 * assumed. Cloudflare now ships this as a first-class binding (Wrangler
 * >=4.36.0, confirmed current as of this block): near-zero added latency
 * (counters are cached locally per Cloudflare location) and no custom
 * class/storage code to maintain, so it replaced the original approach.
 *
 * Keys by IP (cf-connecting-ip), not the binding's own best-practice
 * recommendation of a stable user/tenant ID -- justified here because the
 * strict AUTH_RATE_LIMITER guards pre-authentication endpoints (no userId
 * exists yet), and the looser API_RATE_LIMITER is meant as a coarse abuse
 * floor across the whole API, not a precise per-tenant quota. Keying
 * authenticated routes by userId instead is a reasonable future refinement.
 *
 * PUBLIC_RATE_LIMITER (QR Engagement Block 2) guards the anonymous QR/
 * feedback surface the same way AUTH_RATE_LIMITER guards pre-auth
 * endpoints -- IP is the only signal available pre-token-resolution.
 */
type RateLimitBinding =
  | 'AUTH_RATE_LIMITER'
  | 'API_RATE_LIMITER'
  | 'PUBLIC_RATE_LIMITER'
  | 'OTP_RATE_LIMITER'
  | 'FOLLOWUP_QUESTION_RATE_LIMITER'
  | 'LOOKUP_RATE_LIMITER';

type RateLimitKeyResolver = (request: Request) => string | Promise<string>;

export function rateLimit(binding: RateLimitBinding, resolveKey?: RateLimitKeyResolver) {
  return createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
    // Server-side web actions reach this Worker through a Worker-to-Worker
    // request, where cf-connecting-ip may identify the web Worker rather than
    // the customer. Routes handling public identifiers (such as an OTP phone
    // number) can therefore supply a stable subject key and avoid collapsing
    // every customer into one shared rate-limit bucket.
    const key = resolveKey
      ? await resolveKey(c.req.raw.clone())
      : (c.req.header('cf-connecting-ip') ?? 'unknown');
    const { success } = await c.env[binding].limit({ key });
    if (!success) {
      throw new AppError('Too many requests. Please try again shortly.', 429, 'RATE_LIMITED');
    }
    await next();
  });
}

/**
 * Per-customer limit for routes behind `customerAuthenticate`. The IP-keyed limiters above cannot tell customers
 * apart on these routes: the web app reaches this API Worker to Worker, so every customer's request can arrive with
 * the same cf-connecting-ip, and one shared bucket of a few requests per minute is spent by whoever is active. Here
 * the key is the authenticated customer id, so one customer can never use up another's budget.
 *
 * Must run AFTER `customerAuthenticate` (it needs the customer id; it fails closed with 401 if it is missing).
 * The binding ships in wrangler.toml with the code that uses it; if it is ever absent (config drift) this falls back
 * to the PUBLIC limiter, still keyed by customer and never by the shared IP.
 */
export function rateLimitByCustomer() {
  return createMiddleware<{ Bindings: Bindings; Variables: CustomerAuthVariables }>(
    async (c, next) => {
      const customerId = c.get('customerId');
      if (!customerId) {
        throw new AppError('Missing or malformed Authorization header.', 401, 'UNAUTHENTICATED');
      }
      const limiter = c.env.CUSTOMER_API_RATE_LIMITER ?? c.env.PUBLIC_RATE_LIMITER;
      const { success } = await limiter.limit({ key: `customer:${customerId}` });
      if (!success) {
        throw new AppError('Too many requests. Please try again shortly.', 429, 'RATE_LIMITED');
      }
      await next();
    },
  );
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).slice(0, 32);
}

type CashierAuthKind = 'login' | 'session' | 'refresh' | 'logout';

/** What the request is "about", hashed: the account for a login, the ticket or token otherwise. Never the raw secret. */
async function subjectOf(kind: CashierAuthKind, body: unknown): Promise<string> {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const raw = kind === 'login' ? record.email : kind === 'session' ? record.ticket : record.refreshToken;
  return typeof raw === 'string' && raw.length > 0 ? digest(kind === 'login' ? raw.trim().toLowerCase() : raw) : 'none';
}

/**
 * SEC-CASHIER-R2 F6: throttling for the four cashier authentication endpoints (staff login is unchanged).
 *
 * The web app reaches this API Worker to Worker, so every web sign-in used to share the single per-IP bucket of the web
 * Worker: ten cashier sign-ins a minute for ALL staff, or a lockout. Three buckets replace it, each with a key a caller
 * cannot choose:
 *  1. per account (or ticket / token) AND source, on the strict AUTH limiter: caps guessing one account from one source.
 *     The source is the signed client address when the web Worker forwarded one, otherwise "shared" (the web Worker).
 *  2. per account across all sources, on the API limiter (300/min): caps distributed guessing against one account
 *     without letting one attacker lock a victim out at the strict 10/min rate.
 *  3. per source across accounts, on the strict AUTH limiter, ONLY for a signed client address: caps credential
 *     stuffing from one person. Without a signed address there is no way to tell clients apart, so no shared bucket is
 *     created (it would be the global lockout this replaces).
 * A request's own headers cannot pick a bucket: the address is trusted only with a valid signature (see
 * lib/client-attribution.ts). Replaying one refresh token or ticket is limited by (1) and (2) because they are keyed by it.
 */
export function cashierAuthRateLimit(kind: CashierAuthKind) {
  return createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
    let body: unknown = null;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      // Not JSON: the handler's own validation answers it. It still counts against the "none" subject below.
    }
    const subject = await subjectOf(kind, body);
    const client = await resolveClient(c.req.raw.headers, c.env.CLIENT_ATTRIBUTION_SECRET);
    const source = client.trusted ? `ip:${client.ip}` : 'shared';
    const checks: { limiter: RateLimit; key: string }[] = [
      { limiter: c.env.AUTH_RATE_LIMITER, key: `cashier:${kind}:subject:${subject}:${source}` },
      { limiter: c.env.API_RATE_LIMITER, key: `cashier:${kind}:subject:${subject}` },
    ];
    if (client.trusted) checks.push({ limiter: c.env.AUTH_RATE_LIMITER, key: `cashier:${kind}:source:${client.ip}` });
    for (const { limiter, key } of checks) {
      const { success } = await limiter.limit({ key });
      if (!success) throw new AppError('Too many requests. Please try again shortly.', 429, 'RATE_LIMITED');
    }
    await next();
  });
}
