import { afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb, type Database } from '../../src/db/client';

/**
 * R8-G compatibility seam. When APP_RUNTIME_DATABASE_URL is set, application SERVICES built through this helper talk to the database as the
 * restricted, non-owner runtime login, while a suite's own fixtures keep using its admin connection. When it is not set (the default, and
 * CI today) this returns the database it was given, so behaviour is unchanged.
 * One runtime connection is opened PER ORIGINAL CLIENT, so two services a test builds on two different clients to race each other stay on two
 * different connections (a shared connection would silently serialize them). Each runtime connection is closed when its original client ends,
 * and any left over are closed after the file. pg queues queries issued before connect() resolves.
 */
const byOriginalClient = new WeakMap<object, Database>();
const open = new Set<Client>();

afterAll(async () => {
  await Promise.all([...open].map((c) => c.end().catch(() => undefined)));
  open.clear();
});

export function appDbOf(fallback: Database): Database {
  const url = process.env.APP_RUNTIME_DATABASE_URL;
  if (!url) return fallback;
  const original = (fallback as unknown as { $client?: object }).$client ?? fallback;
  const hit = byOriginalClient.get(original);
  if (hit) return hit;
  const client = new Client({ connectionString: url });
  open.add(client);
  client.connect().catch((e) => { console.error('[runtime-db] connect failed:', (e as Error).message); });
  const originalEmitter = original as { once?: (event: string, listener: () => void) => void };
  originalEmitter.once?.('end', () => { open.delete(client); void client.end().catch(() => undefined); });
  const db = buildDb(client);
  byOriginalClient.set(original, db);
  return db;
}
