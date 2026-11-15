import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/** H3-5 on a SCRATCH Postgres: "issue unless one was issued in the last N seconds" is atomic under concurrency. */
describe.skipIf(!process.env.DATABASE_URL)('password reset request suppression (integration, scratch database)', () => {
  let c: Client;
  let repos: ReturnType<typeof createRepositories>;
  const newUser = async () =>
    (await c.query(`insert into users (email, password_hash, full_name) values ($1,'x','Reset') returning id`, [`r-${randomUUID()}@example.test`])).rows[0].id as string;
  const input = (userId: string) => ({ userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000), requestedIp: null });
  const live = async (userId: string) =>
    Number((await c.query(`select count(*) from password_reset_tokens where user_id=$1 and consumed_at is null and invalidated_at is null`, [userId])).rows[0].count);

  beforeAll(async () => {
    c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    repos = createRepositories(buildDb(c as never));
  });
  afterAll(async () => {
    await c?.end();
  });

  it('first request issues; a second inside the window is suppressed and leaves the first link valid', async () => {
    const u = await newUser();
    const first = await repos.passwordResetTokens.issueUnlessRecent(input(u), 120);
    expect(first).not.toBeNull();
    expect(await repos.passwordResetTokens.issueUnlessRecent(input(u), 120)).toBeNull();
    expect(await live(u)).toBe(1);
    expect(await repos.passwordResetTokens.consume(first!.id)).toBe(true);
  });

  it('8 simultaneous requests on separate connections issue exactly ONE token (the race is closed)', async () => {
    const u = await newUser();
    const clients = await Promise.all(Array.from({ length: 8 }, async () => { const k = new Client({ connectionString: process.env.DATABASE_URL }); await k.connect(); return k; }));
    try {
      const results = await Promise.all(clients.map((k) => createRepositories(buildDb(k as never)).passwordResetTokens.issueUnlessRecent(input(u), 120)));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await live(u)).toBe(1);
    } finally {
      await Promise.all(clients.map((k) => k.end()));
    }
  });

  it('after the window a new request issues a fresh token and cancels the older one (never two live links)', async () => {
    const u = await newUser();
    const first = await repos.passwordResetTokens.issueUnlessRecent(input(u), 120);
    await c.query(`update password_reset_tokens set created_at = now() - interval '121 seconds' where id=$1`, [first!.id]);
    const second = await repos.passwordResetTokens.issueUnlessRecent(input(u), 120);
    expect(second).not.toBeNull();
    expect(await live(u)).toBe(1);
    expect(await repos.passwordResetTokens.consume(first!.id)).toBe(false);
  });

  it('a consumed, invalidated or expired token does not suppress; other users are unaffected', async () => {
    const u = await newUser();
    const t = await repos.passwordResetTokens.issueUnlessRecent(input(u), 120);
    await repos.passwordResetTokens.consume(t!.id);
    const t2 = await repos.passwordResetTokens.issueUnlessRecent(input(u), 120);
    expect(t2).not.toBeNull();
    await repos.passwordResetTokens.invalidateById(t2!.id);
    const t3 = await repos.passwordResetTokens.issueUnlessRecent(input(u), 120);
    expect(t3).not.toBeNull();
    await c.query(`update password_reset_tokens set expires_at = now() - interval '1 second' where id=$1`, [t3!.id]);
    expect(await repos.passwordResetTokens.issueUnlessRecent(input(u), 120)).not.toBeNull();
    expect(await repos.passwordResetTokens.issueUnlessRecent(input(await newUser()), 120)).not.toBeNull();
  });

  it('a failed-send cancel (invalidateById) lets an immediate retry through', async () => {
    const u = await newUser();
    const t = await repos.passwordResetTokens.issueUnlessRecent(input(u), 120);
    await repos.passwordResetTokens.invalidateById(t!.id);
    expect(await repos.passwordResetTokens.issueUnlessRecent(input(u), 120)).not.toBeNull();
  });
});
