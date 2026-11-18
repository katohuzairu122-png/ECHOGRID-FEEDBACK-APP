import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { AppError } from '../lib/errors';
import { rateLimitSource, resolveClient } from '../lib/client-attribution';
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

/**
 * H2 (independent review of #439): the global API floor (300/min, mounted on every route) was keyed by the raw `cf-connecting-ip`. The
 * web app reaches this Worker Worker to Worker, so all web users shared that single bucket: one busy or hostile source could spend
 * the whole floor and 429 everyone, whatever the per-endpoint limiters did.
 *
 *  - `CLIENT_ATTRIBUTION_SECRET` NOT configured: exactly `rateLimit('API_RATE_LIMITER')` (raw `cf-connecting-ip`, else `unknown`).
 *  - Configured and the request carries a VALID signed attribution (current or previous secret, 60 s past / 5 s future): key
 *    `src:<client address>`, the real client's address (IPv6 collapsed to its /64, see `rateLimitSource`). Only the secret holder can
 *    produce the header, so a caller cannot choose this bucket; a forged, stale, tampered or wrong-secret header is simply not
 *    trusted and falls through to the next case.
 *  - Configured but the request is unsigned or invalid: the legacy raw-address key, unchanged. This is never worse than before, so a
 *    web Worker that fails to sign (mismatch, skew, missing address) only keeps today's shared-egress behaviour for that traffic.
 *
 * The `src:` prefix cannot collide with a legacy key (those are addresses or `unknown`) or with the account/ticket keys of the
 * attributed auth limiter. The limit itself is unchanged: nothing is loosened for any single source.
 */
export function globalApiRateLimit() {
  return createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
    const legacy = c.req.header('cf-connecting-ip') ?? 'unknown';
    let key = legacy;
    if (c.env.CLIENT_ATTRIBUTION_SECRET) {
      const client = await resolveClient(
        c.req.raw.headers,
        c.env.CLIENT_ATTRIBUTION_SECRET,
        Date.now(),
        c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS,
      );
      if (client.trusted) key = `src:${rateLimitSource(client.ip)}`;
    }
    const { success } = await c.env.API_RATE_LIMITER.limit({ key });
    if (!success) throw new AppError('Too many requests. Please try again shortly.', 429, 'RATE_LIMITED');
    await next();
  });
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).slice(0, 32);
}

type CashierAuthKind = 'login' | 'session' | 'refresh' | 'logout' | 'managed-login' | 'switch' | 'branches';
/** H3: the staff recovery and account endpoints that share the attributed throttle. */
type StaffAuthKind = 'signup' | 'reset-request' | 'reset-confirm' | 'password-change' | 'admin-reauth';
type AuthKind = CashierAuthKind | StaffAuthKind;

/**
 * What the request is "about", hashed: the account for a login/signup/reset request, the ticket, reset token or refresh token
 * otherwise, and the authenticated user id for a password change. Never the raw secret.
 */
async function subjectOf(kind: AuthKind, body: unknown, userId?: string): Promise<string> {
  if (kind === 'password-change' || kind === 'admin-reauth') return userId ? digest(`user:${userId}`) : 'none';
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  // CASHIER-AUTH-02A: a managed sign-in is about (business code, username), never an email. Normalised so case and spacing
  // variants share one bucket; without this every managed sign-in would share the single `none` subject floor.
  if (kind === 'managed-login') {
    const code = typeof record.businessCode === 'string' ? record.businessCode.toUpperCase().replace(/[\s-]/g, '') : '';
    const name = typeof record.username === 'string' ? record.username.trim().toLowerCase() : '';
    return code && name ? digest(`managed:${code}:${name}`) : 'none';
  }
  const byEmail = kind === 'login' || kind === 'signup' || kind === 'reset-request';
  const raw = byEmail ? record.email : kind === 'session' ? record.ticket : kind === 'reset-confirm' ? record.token : record.refreshToken;
  return typeof raw === 'string' && raw.length > 0 ? digest(byEmail ? raw.trim().toLowerCase() : raw) : 'none';
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
function attributedAuthRateLimit(scope: AuthScope, kind: AuthKind, legacyStrict: boolean) {
  return createMiddleware<{ Bindings: Bindings; Variables: { userId?: string } }>(async (c, next) => {
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
    const subject = await subjectOf(kind, body, c.get('userId'));
    const rawConnecting = c.req.header('cf-connecting-ip') ?? 'unknown';
    const connecting = rateLimitSource(rawConnecting);
    const prefix = `${scope}:${kind}`;
    const checks: { limiter: RateLimit; key: string }[] = [];
    if (!c.env.CLIENT_ATTRIBUTION_SECRET) {
      // Previous behaviour, unchanged.
      if (legacyStrict) checks.push({ limiter: c.env.AUTH_RATE_LIMITER, key: rawConnecting });
    } else {
      const client = await resolveClient(
        c.req.raw.headers,
        c.env.CLIENT_ATTRIBUTION_SECRET,
        Date.now(),
        c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS,
      );
      if (client.trusted) {
        const source = rateLimitSource(client.ip);
        checks.push(
          { limiter: c.env.AUTH_RATE_LIMITER, key: `${prefix}:subject:${subject}:ip:${source}` },
          { limiter: c.env.AUTH_RATE_LIMITER, key: `${prefix}:source:${source}` },
        );
      } else {
        // No account-keyed strict bucket here (review M1): it was global across addresses, so one remote caller could hold a
        // named account at 429. Direct callers are bounded per address (/64 for IPv6) and by the per-account floor below.
        checks.push({ limiter: c.env.AUTH_RATE_LIMITER, key: `${prefix}:direct:${connecting}` });
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

/**
 * H3: signup, password-reset request, password-reset confirm and password change use the same attributed builder as staff login
 * (secret unset = the previous per-IP bucket plus the floor; secret set = per-source buckets, no account-wide strict bucket).
 * Password change must be mounted AFTER `authenticate`: its subject is the authenticated user id, so one user's attempts (or a
 * stolen token's) never spend another user's budget. Keys are `staff:<kind>:...`, disjoint from login and cashier keys.
 */
export const signupRateLimit = () => attributedAuthRateLimit('staff', 'signup', true);
export const passwordResetRequestRateLimit = () => attributedAuthRateLimit('staff', 'reset-request', true);
export const passwordResetConfirmRateLimit = () => attributedAuthRateLimit('staff', 'reset-confirm', true);
export const passwordChangeRateLimit = () => attributedAuthRateLimit('staff', 'password-change', true);

/** CASHIER-AUTH-02A: managed cashier sign-in (strict per-IP legacy bucket plus a per business-code/username floor). */
export const managedCashierLoginRateLimit = () => attributedAuthRateLimit('cashier', 'managed-login', true);

/** CASHIER-AUTH-02A: administrator re-authentication; keyed by the authenticated user, mounted AFTER authenticate. */
export const adminReauthRateLimit = () => attributedAuthRateLimit('staff', 'admin-reauth', true);
