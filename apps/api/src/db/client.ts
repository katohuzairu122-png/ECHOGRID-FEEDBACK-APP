import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

// Exported so scripts that connect outside a Worker request (e.g. the
// permission seed script, which uses DATABASE_URL directly) build the same
// Drizzle instance shape as the request path does, instead of duplicating
// this call.
export function buildDb(client: Client) {
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof buildDb>;

/**
 * Creates a new Postgres client + Drizzle instance for a single request.
 * Hyperdrive maintains the real connection pool upstream, so creating a new
 * `pg.Client` per request is fast and is Cloudflare's documented pattern:
 * https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
 *
 * Call `close()` when the request is done (ideally via `ctx.waitUntil`, wired
 * up in Block 7) so Postgres sees a clean disconnect rather than an abrupt
 * cutoff.
 */
export async function createDb(
  hyperdrive: Hyperdrive,
): Promise<{ db: Database; close: () => Promise<void> }> {
  const client = new Client({ connectionString: hyperdrive.connectionString });
  await client.connect();
  return { db: buildDb(client), close: () => client.end() };
}
