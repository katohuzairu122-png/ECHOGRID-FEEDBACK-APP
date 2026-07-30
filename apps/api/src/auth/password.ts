import { constantTimeEqual } from './crypto-utils';

/**
 * Password hashing via PBKDF2-HMAC-SHA256 (Web Crypto, native to the
 * Workers runtime -- no WASM or native-binding dependency). OWASP's 2026 top
 * pick is Argon2id, but every current Argon2 option for Workers is an
 * unofficial community WASM fork requiring manual binary repackaging around
 * Cloudflare's non-standard WASM loading -- not something to depend on for
 * production password storage. PBKDF2 remains an OWASP-approved choice
 * (explicitly the recommended one for FIPS compliance) at the iteration
 * count below. The hash is self-describing (algorithm + iteration count +
 * salt embedded), so this can move to Argon2id later, per-hash, on next
 * successful login, without forcing a mass invalidation.
 */

const ALGORITHM = 'PBKDF2';
const HASH = 'SHA-256';
// Exported so callers going through Pbkdf2Worker (pbkdf2-worker.ts) --
// AuthService, notably -- can pass the same constant explicitly, rather
// than each call site guessing or duplicating it.
export const PASSWORD_ITERATIONS = 600_000; // OWASP minimum for PBKDF2-HMAC-SHA256 as of 2026
const KEY_LENGTH_BITS = 256;
const SALT_LENGTH_BYTES = 16;
// Cloudflare Workers' native WebCrypto implementation hard-caps a single
// PBKDF2 deriveBits() call at 100k iterations (confirmed by the runtime's own
// NotSupportedError, not documented anywhere obvious in advance) -- ITERATIONS
// above needs chaining, not a single call, or every password hash/verify
// throws in the real deployed environment despite working fine under Node's
// crypto (no such cap), which is exactly how this went unnoticed through 245
// passing local/integration tests.
const WORKERS_PBKDF2_ITERATION_CAP = 100_000;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/**
 * Runs PBKDF2 for the full requested iteration count by chaining native
 * calls of at most WORKERS_PBKDF2_ITERATION_CAP each -- total HMAC-SHA256
 * work factor is unchanged (e.g. 6 x 100k = the same 600k rounds a single
 * call would have done), so this preserves the OWASP-recommended cost
 * rather than silently capping it at 100k. Only the first round salts the
 * actual (low-entropy) password; every subsequent round's "password" is the
 * prior round's derived 256-bit output, which is already effectively random
 * -- reusing the same salt for those rounds adds no meaningful weakness
 * (salting exists to defeat precomputation against guessable inputs, and a
 * 256-bit intermediate isn't one). A count at or under the cap runs as one
 * native call, identical to the previous implementation.
 */
async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  let keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    ALGORITHM,
    false,
    ['deriveBits'],
  );

  let remaining = iterations;
  let bits: ArrayBuffer;
  do {
    const roundIterations = Math.min(remaining, WORKERS_PBKDF2_ITERATION_CAP);
    bits = await crypto.subtle.deriveBits(
      { name: ALGORITHM, salt, iterations: roundIterations, hash: HASH },
      keyMaterial,
      KEY_LENGTH_BITS,
    );
    remaining -= roundIterations;
    if (remaining > 0) {
      keyMaterial = await crypto.subtle.importKey('raw', bits, ALGORITHM, false, ['deriveBits']);
    }
  } while (remaining > 0);

  return new Uint8Array(bits);
}

/**
 * Generic PBKDF2 primitive, parameterized on iteration count. Extracted so
 * customer-auth/otp.ts can reuse the same self-describing hash format at a
 * much lower iteration count (OTP security comes from short expiry + a
 * capped attempt count, not offline-hash resistance, so paying the full
 * 600k-iteration password cost on every SMS code check would only add
 * latency, not real protection). Returns pbkdf2$<iterations>$<saltB64>$<hashB64>.
 */
export async function pbkdf2Hash(input: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const derived = await deriveBits(input, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * Verifies input against a hash produced by pbkdf2Hash(). Reads the
 * iteration count from the stored hash, not any current constant, so past
 * hashes stay verifiable even after a caller's iteration count changes.
 */
export async function pbkdf2Verify(input: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iterationsStr, saltB64, hashB64] = parts;
  if (iterationsStr === undefined || saltB64 === undefined || hashB64 === undefined) return false;
  const iterations = Number(iterationsStr);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  const derived = await deriveBits(input, fromBase64(saltB64), iterations);
  return constantTimeEqual(derived, fromBase64(hashB64));
}

/** Thin wrapper over pbkdf2Hash at the password-strength iteration count. */
export async function hashPassword(password: string): Promise<string> {
  return pbkdf2Hash(password, PASSWORD_ITERATIONS);
}

/** Thin wrapper over pbkdf2Verify -- unchanged external behavior/format. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return pbkdf2Verify(password, storedHash);
}
