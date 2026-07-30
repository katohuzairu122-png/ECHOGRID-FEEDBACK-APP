import type { Db } from '../db/client';

/**
 * Constructor-injects the request-scoped Database so repositories are cheap
 * to unit test with a fake db (Block 9) and never reach for a global
 * connection. Deliberately does NOT provide generic CRUD methods -- Drizzle's
 * query builder is already type-safe and ergonomic per table; a
 * one-size-fits-all generic repository fights that type system more than it
 * helps. Concrete repositories below share the two conventions that matter
 * instead: never return soft-deleted rows by default, and (for every
 * business-owned table) never query across tenant boundaries.
 */
export abstract class BaseRepository {
  constructor(protected readonly db: Db) {}
}
