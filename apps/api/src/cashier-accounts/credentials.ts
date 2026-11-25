import { sign, verify } from 'hono/jwt';

/**
 * CASHIER-AUTH-02A helpers: the managed-cashier namespace (business code, username), credential generation and the
 * administrator re-authentication proof. Pure and dependency-free so every rule is unit-testable.
 */

/** D-3: a public, PERMANENT sign-in code: assigned once, with the first cashier account, and never changed afterwards. 10 characters from 32 unambiguous symbols (no I, O, 0 or 1). NOT a secret. */
export const BUSINESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const BUSINESS_CODE_LENGTH = 10;
const BUSINESS_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
/** Canonical username: lowercase, 3 to 32 characters, unique inside ONE business only. Mirrors users_login_username_check. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** D-5. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
export const REAUTH_PROOF_TTL_SECONDS = 5 * 60;

/** Uniform random string without modulo bias (rejection sampling over crypto.getRandomValues). */
function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const generateBusinessCode = () => randomString(BUSINESS_CODE_ALPHABET, BUSINESS_CODE_LENGTH);

/** Canonical business code (case, spaces and hyphens ignored) or null when it cannot be a code at all. */
export function normalizeBusinessCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return BUSINESS_CODE_PATTERN.test(code) ? code : null;
}

/** Canonical username or null. Never throws: the sign-in path must treat a malformed value as just another failure. */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return USERNAME_PATTERN.test(name) ? name : null;
}

export function isAcceptablePassword(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= MIN_PASSWORD_LENGTH && raw.length <= MAX_PASSWORD_LENGTH;
}

const REAUTH_TYPE = 'cashier_admin_reauth';
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * D-5: proof that THIS administrator re-entered their password for THIS business within the last 5 minutes. Its `type` is not
 * `access`, so it can never verify as an access token (and it deliberately does not use the cashier scope claim names, so the scope guard never mistakes it for a cashier token), and it is bound to a user and a business so it is useless for another.
 * This is password re-entry, NOT multi-factor authentication.
 */
export async function signAdminReauthProof(userId: string, businessId: string, secret: string, type: string = REAUTH_TYPE): Promise<{ proof: string; expiresAt: Date }> {
  const iat = nowSeconds();
  const exp = iat + REAUTH_PROOF_TTL_SECONDS;
  const proof = await sign({ sub: userId, biz: businessId, type, iat, exp }, secret, 'HS256');
  return { proof, expiresAt: new Date(exp * 1000) };
}

/** True only for a valid, unexpired proof issued to exactly this user for exactly this business. */
export async function verifyAdminReauthProof(proof: string | undefined, userId: string, businessId: string, secret: string, type: string = REAUTH_TYPE): Promise<boolean> {
  if (!proof) return false;
  try {
    const p = (await verify(proof, secret, 'HS256')) as { sub?: unknown; biz?: unknown; type?: unknown; exp?: unknown };
    return p.type === type && p.sub === userId && p.biz === businessId && typeof p.exp === 'number' && p.exp > nowSeconds();
  } catch {
    return false;
  }
}
