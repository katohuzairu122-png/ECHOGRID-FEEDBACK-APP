/**
 * Shared guard for post-login `next` destinations. Client-safe (no server-only imports).
 *
 * The earlier inline check (`startsWith('/') && !startsWith('//')`) let `/\evil.test` through:
 * WHATWG URL parsing treats `\` as `/` for special schemes, so `new URL('/\\evil.test', base)`
 * resolves to `https://evil.test`. This helper accepts only same-origin relative paths.
 */
const PLACEHOLDER_ORIGIN = 'https://safe-redirect.invalid';
const MAX_LENGTH = 2048;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

export function safeInternalPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return fallback;
  if (value[0] !== '/' || value[1] === '/') return fallback;
  if (FORBIDDEN_CHARS.test(value)) return fallback;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  // Reject encoded backslashes / protocol-relative forms that a downstream decoder could revive.
  if (FORBIDDEN_CHARS.test(decoded) || decoded.startsWith('//')) return fallback;
  try {
    if (new URL(value, PLACEHOLDER_ORIGIN).origin !== PLACEHOLDER_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return value;
}
