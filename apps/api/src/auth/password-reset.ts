/**
 * Password-reset constants and primitives, kept separate from
 * auth.service.ts's orchestration so the "what is a valid reset token"
 * rules stay testable in isolation -- the same split
 * customer-auth/otp.ts already establishes for OTP codes.
 */

/**
 * 32 bytes = 256 bits of entropy, hex-encoded to 64 characters. Sized to be
 * unguessable rather than short: unlike an OTP the user never types this by
 * hand, it only ever travels inside a link, so there is no usability reason
 * to trade away entropy. At this size the token needs no attempt cap (see
 * db/schema/password-reset-tokens.ts) -- brute force is not a reachable
 * attack, so rate limiting exists to protect the *email-sending* side, not
 * the token itself.
 */
const TOKEN_BYTES = 32;

/**
 * 60 minutes. Deliberately longer than OTP_EXPIRY_MINUTES (10): an SMS code
 * is typed within seconds of arriving, whereas a reset email may sit behind
 * slow delivery, a spam filter, or a user who checks mail on another device
 * -- a 10-minute link would generate support load, not security. Still far
 * short of the 24 hours some products use: the token is a full account
 * takeover if intercepted, and every extra hour is exposure with no user
 * benefit, since anyone who misses the window can simply request another.
 */
export const PASSWORD_RESET_EXPIRY_MINUTES = 60;

/**
 * Minimum length for a new password, matching auth.dto.ts's signupSchema
 * exactly. Exported so the reset/change DTOs reference one constant instead
 * of re-typing `12` in three places and letting them drift -- a reset flow
 * that accepted weaker passwords than signup would quietly become the
 * easiest way to get a weak password into the system.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Cryptographically random reset token. crypto.getRandomValues, never
 * Math.random -- a predictable reset token is a direct account-takeover
 * vector, the same reasoning generateOtpCode() documents.
 */
export function generateResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function resetTokenExpiresAt(): Date {
  return new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60_000);
}

/**
 * Builds the link a user clicks from their email. Kept here rather than in
 * the email template so the route shape (`/reset-password?token=...`) has
 * exactly one definition shared by the API and, later, apps/web's page.
 *
 * `webBaseUrl` is passed in (from the WEB_BASE_URL binding) rather than
 * hardcoded -- local dev, staging and production all differ, and baking a
 * production URL into source would silently send staging users to
 * production, the same class of mistake ALLOWED_ORIGINS was moved to
 * [vars] to avoid.
 */
export function buildResetLink(webBaseUrl: string, token: string): string {
  // Trailing slashes are stripped so a base URL configured either way
  // produces one canonical link rather than a `//reset-password` path that
  // some routers treat as a different route.
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}
