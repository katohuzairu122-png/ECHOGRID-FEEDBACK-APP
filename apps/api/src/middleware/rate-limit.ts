import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
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
