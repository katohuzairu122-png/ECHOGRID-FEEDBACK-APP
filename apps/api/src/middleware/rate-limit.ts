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

/** Cashier auth bodies are a few hundred bytes; anything larger is refused before it is buffered or parsed. */
const CASHIER_AUTH_MAX_BODY_BYTES = 8 * 1024;

/** Reads at most `maxBytes` of the body as text; null when it is larger. An unreadable body reads as empty. */
async function readBounded(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Not awaited: on a cloned (tee'd) body the cancel promise settles only when BOTH branches are cancelled.
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return '';
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

type AuthScope = 'cashier' | 'staff';

/**
 * The shared throttle behind the cashier auth endpoints (SEC-CASHIER-R2 F6) and the staff login (STG-SEC-02B, design option A in
 * docs/STAFF-LOGIN-THROTTLING-DESIGN.md).
 *
 * The web app reaches this API Worker to Worker, so every web sign-in shares the web Worker's egress address: a single
 * per-IP bucket (the previous behaviour) locks ALL users out after ten sign-ins a minute, and lets one person lock everyone
 * out. Whether the real client can be told apart depends on `CLIENT_ATTRIBUTION_SECRET` (lib/client-attribution.ts):
 *
 *  - NOT configured (the shipped state): behaviour is exactly the previous one. Where the endpoint was throttled
 *    (`legacyStrict`) the strict per-IP bucket on the raw `cf-connecting-ip` key is kept unchanged. No source can be
 *    distinguished, so no new account-keyed STRICT bucket is created (it would let anyone lock a named account out). Only an
 *    account/token-keyed floor on the generous API limiter is added.
 *  - Configured: the web Worker signs the real client address, so an UNSIGNED request is by definition a direct caller and gets
 *    the strict per-IP bucket plus a strict account bucket of its own ("direct"). Signed requests get a strict
 *    per-account-and-source bucket and a strict per-source bucket, which never touch the unsigned buckets, so a direct attacker
 *    cannot spend a signed user's budget and one signed person cannot spend another's.
 *
 * In both modes the account (or ticket/token) hash has a floor on the API limiter (300/min) that caps distributed guessing.
 * No header a request sends can pick a bucket: the address is trusted only with a valid signature (current secret, or the
 * previous one during a rotation). The account is only ever hashed into a key, never stored raw.
 *
 * Residual risk (documented, not removable here): with the secret configured, web requests that fail to verify (mismatched
 * value, clock skew beyond 60 s past / 5 s future, missing client address) are treated as direct callers and share the web
 * Worker's egress bucket. Roll out the secret to the web Worker FIRST, then the API; rollback is removing it from the API.
 */
function attributedAuthRateLimit(scope: AuthScope, kind: CashierAuthKind, legacyStrict: boolean) {
  return createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > CASHIER_AUTH_MAX_BODY_BYTES) {
      throw new AppError('Request body too large.', 400, 'PAYLOAD_TOO_LARGE');
    }
    // Bounded read: stop pulling the body the moment it passes the cap, so an oversized chunked body (no
    // content-length) is never fully buffered here.
    const text = await readBounded(c.req.raw.clone(), CASHIER_AUTH_MAX_BODY_BYTES);
    if (text === null) throw new AppError('Request body too large.', 400, 'PAYLOAD_TOO_LARGE');
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the handler's own validation answers it. It still counts against the "none" subject below.
    }
    const subject = await subjectOf(kind, body);
    const connecting = c.req.header('cf-connecting-ip') ?? 'unknown';
    const prefix = `${scope}:${kind}`;
    const checks: { limiter: RateLimit; key: string }[] = [];
    if (!c.env.CLIENT_ATTRIBUTION_SECRET) {
      // Previous behaviour, unchanged.
      if (legacyStrict) checks.push({ limiter: c.env.AUTH_RATE_LIMITER, key: connecting });
    } else {
      const client = await resolveClient(
        c.req.raw.headers,
        c.env.CLIENT_ATTRIBUTION_SECRET,
        Date.now(),
        c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS,
      );
      if (client.trusted) {
        checks.push(
          { limiter: c.env.AUTH_RATE_LIMITER, key: `${prefix}:subject:${subject}:ip:${client.ip}` },
          { limiter: c.env.AUTH_RATE_LIMITER, key: `${prefix}:source:${client.ip}` },
        );
      } else {
        checks.push(
          { limiter: c.env.AUTH_RATE_LIMITER, key: `${prefix}:direct:${connecting}` },
          { limiter: c.env.AUTH_RATE_LIMITER, key: `${prefix}:subject:${subject}:direct` },
        );
      }
    }
    checks.push({ limiter: c.env.API_RATE_LIMITER, key: `${prefix}:subject:${subject}` });
    for (const { limiter, key } of checks) {
      const { success } = await limiter.limit({ key });
      if (!success) throw new AppError('Too many requests. Please try again shortly.', 429, 'RATE_LIMITED');
    }
    await next();
  });
}

/** SEC-CASHIER-R2 F6: the four cashier authentication endpoints (strict per-IP legacy bucket on login and session only). */
export function cashierAuthRateLimit(kind: CashierAuthKind) {
  return attributedAuthRateLimit('cashier', kind, kind === 'login' || kind === 'session');
}

/** STG-SEC-02B: staff `POST /auth/login` (design option A). Other staff auth endpoints keep `rateLimit('AUTH_RATE_LIMITER')`. */
export function staffLoginRateLimit() {
  return attributedAuthRateLimit('staff', 'login', true);
}
