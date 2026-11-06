import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { readRestrictedDurableProvenance } from '../../src/billing/stripe-read/restricted-durable-provenance-read';

/**
 * DEV-21: actual PostgreSQL permissions, on a disposable database with
 * disposable read-only/auditor login. No financial writers are activated.
 */
describe.skipIf(!process.env.DATABASE_URL)('DEV-21 dedicated audit reader (scratch PostgreSQL)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const suffix = randomBytes(4).toString('hex');
  const dbName = `echogrid_dev21_${suffix}`;
  const guestName = `dev21_guest_${suffix}`;
  const auditorName = `dev21_aud_${suffix}`;
  const password = randomBytes(12).toString('hex');
  const api = resolve(__dirname, '../..');
  const urlFor = (name: string, role?: string): string => {
    const u = new URL(base.toString());
    u.pathname = `/${name}`;
    if (role) { u.username = role; u.password = password; }
    return u.toString();
  };
  const clients: Client[] = [];
  let root: Client;

  beforeAll(async () => {
    root = new Client({ connectionString: urlFor('postgres') });
    await root.connect();
    await root.query(`create role ${guestName} login password '${password}'`);
    await root.query(`create role ${auditorName} login password '${password}'`);
    await root.query(`create database ${dbName}`);
    const migrated = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], {
      cwd: api, encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, DATABASE_URL: urlFor(dbName) },
    });
    if (migrated.status !== 0) throw new Error(`DEV21 scratch migration failed: ${(migrated.stdout + migrated.stderr).slice(-500)}`);
    await root.query(`grant settlement_auditor to ${auditorName} with inherit true, set false`);
  }, 300_000);

  afterAll(async () => {
    for (const client of clients) { try { await client.end(); } catch { /* cleanup */ } }
    try { await root.query(`drop database if exists ${dbName} with (force)`); } catch { /* cleanup */ }
    for (const name of [auditorName, guestName]) {
      try { await root.query(`drop owned by ${name}`); } catch { /* cleanup */ }
      try { await root.query(`drop role if exists ${name}`); } catch { /* cleanup */ }
    }
    try { await root.end(); } catch { /* initialization failure */ }
  });

  const request = {
    businessId: '11111111-1111-4111-8111-111111111111',
    reservationId: '22222222-2222-4222-8222-222222222222',
    authorizationId: '33333333-3333-4333-8333-333333333333',
  };

  it('ordinary login cannot query provenance through the private reader', async () => {
    const client = new Client({ connectionString: urlFor(dbName, guestName) });
    await client.connect(); clients.push(client);
    expect(await readRestrictedDurableProvenance(buildDb(client), request))
      .toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('auditor membership is read-only and yields no authorization for an empty tuple', async () => {
    const client = new Client({ connectionString: urlFor(dbName, auditorName) });
    await client.connect(); clients.push(client);
    const result = await readRestrictedDurableProvenance(buildDb(client), request);
    expect(result).toEqual({ ok: true, authorization: undefined, link: undefined });
    await expect(client.query('insert into settlement_custody_authorization_links default values'))
      .rejects.toThrow();
  });
});
