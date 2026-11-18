/**
 * PostgreSQL error classification shared by services that need to turn a
 * specific database failure into a deliberate API response.
 *
 * Drizzle usually wraps the driver error, leaving the original (with the
 * SQLSTATE `code` and the violated `constraint`) on `cause`. pg reports the
 * constraint as `constraint`; postgres.js as `constraint_name`; both are
 * accepted. Nothing is ever inferred from message text, and failures that do
 * not match are left for the caller to rethrow untouched.
 */
const UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 5;

/**
 * True when `error` (or one of its `cause`s) is a unique_violation (23505).
 * When `constraints` is given, the violated constraint/index must be one of
 * those names; without it any unique violation matches.
 */
export function isUniqueViolation(error: unknown, constraints?: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    const candidate = current as Record<string, unknown>;
    if (candidate.code === UNIQUE_VIOLATION) {
      if (!constraints) return true;
      const name = candidate.constraint ?? candidate.constraint_name;
      if (typeof name === 'string' && constraints.includes(name)) return true;
    }
    current = candidate.cause;
  }
  return false;
}
