/**
 * CUSTOMER-AUTH-S4-01: recovery-code primitives. Pure and database-free.
 *
 * A code is 28 characters of Crockford base32 = 140 bits from the platform CSPRNG
 * (`byte & 31` is unbiased because 256 is a multiple of 32), shown as seven
 * groups of four. It is a high-entropy random value, so a keyed HMAC-SHA-256
 * verifier is the right construction: a slow password KDF adds nothing when the
 * input cannot be guessed, and the key stops offline confirmation of a stolen
 * verifier table. The verifier is bound to the customer id and a purpose label
 * so it can never verify for another customer or another use.
 *
 * Plaintext is returned to the caller exactly once and is never logged, stored
 * or sent. Nothing here is wired to a route.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encoder = new TextEncoder();

export const RECOVERY_CODE_LENGTH = 28;
export const RECOVERY_CODE_ENTROPY_BITS = RECOVERY_CODE_LENGTH * 5;
const MAX_INPUT_LENGTH = 64;
const PURPOSE = 'echo-grid/customer-recovery-code/v1';

export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_LENGTH));
  let chars = '';
  for (const byte of bytes) chars += ALPHABET[byte & 31];
  return chars.match(/.{4}/g)!.join('-');
}

/** Canonical 28-character form, or null if the input cannot be a recovery code. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_LENGTH) return null;
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{28}$/.test(canonical) ? canonical : null;
}

/** A well-formed value no generated code can equal, so malformed input follows the same path as a wrong code. */
export const RECOVERY_CODE_NEVER_MATCHES = '0'.repeat(64);

export async function recoveryCodeVerifier(input: {
  secret: string;
  customerId: string;
  code: string;
}): Promise<string> {
  if (typeof input.secret !== 'string' || encoder.encode(input.secret).length < 32) {
    throw new Error('Recovery code HMAC secret is not configured');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.customerId)) {
    throw new Error('Recovery code verifier requires a customer id');
  }
  const canonical = normalizeRecoveryCode(input.code);
  if (!canonical) throw new Error('Not a recovery code');
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(input.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC', key, encoder.encode(`${PURPOSE}\0${input.customerId.toLowerCase()}\0${canonical}`),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}
