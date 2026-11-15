import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/** SEC-CASHIER-R2 F7 on a SCRATCH Postgres: the selection-ticket spend is atomic, and the tombstone is never a live session. */
describe.skipIf(!process.env.DATABASE_URL)('cashier selection ticket consumption (integration, scratch database)', () => {
  let c: Client;
  let repos: ReturnType<typeof createRepositories>;
  let userId: string;
  beforeAll(async () => {
    c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    repos = createRepositories(buildDb(c as never));
    userId = (await c.query(`insert into users (email, password_hash, full_name) values ($1,'x','Tick') returning id`, [`t-${randomUUID()}@example.test`])).rows[0].id;
  });
  afterAll(async () => {
    await c?.end();
  });

  it('spends a ticket exactly once; a replay returns false', async () => {
    const jti = randomUUID();
    const input = { jti, userId, expiresAt: new Date(Date.now() + 300_000) };
    expect(await repos.refreshTokens.consumeCashierTicket(input)).toBe(true);
    expect(await repos.refreshTokens.consumeCashierTicket(input)).toBe(false);
  });

  it('two concurrent spends of the same ticket: one wins (separate connections)', async () => {
    const c2 = new Client({ connectionString: process.env.DATABASE_URL });
    await c2.connect();
    try {
      const repos2 = createRepositories(buildDb(c2 as never));
      const input = { jti: randomUUID(), userId, expiresAt: new Date(Date.now() + 300_000) };
      const results = await Promise.all([repos.refreshTokens.consumeCashierTicket(input), repos2.refreshTokens.consumeCashierTicket(input)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await c2.end();
    }
  });

  it('the tombstone is not a live session for any liveness or listing query', async () => {
    const jti = randomUUID();
    await repos.refreshTokens.consumeCashierTicket({ jti, userId, expiresAt: new Date(Date.now() + 300_000) });
    expect(await repos.refreshTokens.isSessionLive(userId, jti, Date.now())).toBe(false);
    const row = (await c.query(`select client, token_hash, revoked_at, session_id from refresh_tokens where id=$1`, [jti])).rows[0];
    expect(row.client).toBe('web');
    expect(row.token_hash).toBe('cashier-selection-ticket');
    expect(row.revoked_at).not.toBeNull();
    expect(row.session_id).toBeNull();
  });

  it('a later spend deletes this user\'s expired tombstones but keeps live ones and other users\'', async () => {
    const other = (await c.query(`insert into users (email, password_hash, full_name) values ($1,'x','Other') returning id`, [`o-${randomUUID()}@example.test`])).rows[0].id;
    const old = randomUUID();
    const live = randomUUID();
    const foreign = randomUUID();
    await repos.refreshTokens.consumeCashierTicket({ jti: old, userId, expiresAt: new Date(Date.now() + 300_000) });
    await c.query(`update refresh_tokens set expires_at = now() - interval '1 minute' where id=$1`, [old]);
    await repos.refreshTokens.consumeCashierTicket({ jti: foreign, userId: other, expiresAt: new Date(Date.now() - 60_000) });
    await repos.refreshTokens.consumeCashierTicket({ jti: live, userId, expiresAt: new Date(Date.now() + 300_000) });
    const ids = (await c.query(`select id from refresh_tokens where id = any($1)`, [[old, live, foreign]])).rows.map((r) => r.id);
    expect(ids).toContain(live);
    expect(ids).toContain(foreign);
    expect(ids).not.toContain(old);
  });
});
