/**
 * Same-origin redirect-target validation for post-login `next` parameters.
 *
 * A bare `startsWith('/') && !startsWith('//')` check is NOT enough: the
 * WHATWG URL parser (and every browser) treats `\` like `/`, so `/\evil.test`
 * resolves to another origin. Use this helper at every `next`/`returnTo`
 * sink instead of re-implementing the check.
 */

const PLACEHOLDER_ORIGIN = 'https://placeholder.invalid';
const MAX_LENGTH = 2048;
// C0 controls (incl. tab/CR/LF) and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isSafeShape(candidate: string): boolean {
  return (
    candidate.startsWith('/') &&
    !candidate.startsWith('//') &&
    !candidate.includes('\\') &&
    !CONTROL_CHARS.test(candidate)
  );
}

/**
 * Returns `value` when it is a same-origin relative path, else `fallback`.
 * The accepted value is returned unchanged (query string and fragment kept).
 */
export function safeInternalPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) {
    return fallback;
  }
  if (!isSafeShape(value)) return fallback;

  // One decode pass catches encoded smuggling such as `/%5Cevil.test` or
  // `/%2F%2Fevil.test` should any downstream layer decode before navigating.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (!isSafeShape(decoded)) return fallback;

  try {
    if (new URL(value, PLACEHOLDER_ORIGIN).origin !== PLACEHOLDER_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return value;
}
