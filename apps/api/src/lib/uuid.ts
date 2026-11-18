/**
 * Postgres `uuid` columns accept any 8-4-4-4-12 hexadecimal string, and raise
 * error 22P02 (surfacing as a 500) for anything else. Routes check a path id
 * with this before it reaches a query, so a malformed id is answered as "not
 * found" instead of as a server error.
 *
 * Deliberately not a version/variant check: it answers "will the database
 * accept this as a uuid", not "did we mint it".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
