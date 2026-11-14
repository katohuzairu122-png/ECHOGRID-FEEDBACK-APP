import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/**
 * CASHIER-PWA-01 C6 on a SCRATCH database (DATABASE_URL, never production): the business-scoped list and revocation
 * queries. Proves the SQL predicates (client, business, session, live) that unit-level mocks cannot.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'cashier session management (integration, scratch database)',
  () => {
    let c: Client;
    let repos: ReturnType<typeof createRepositories>;
    let userId: string;
    let bizA: string;
    let bizB: string;
    let branchA: string;
    const now = () => Date.now();

    const row = async (over: Record<string, unknown>) => {
      const r = {
        id: randomUUID(),
        user_id: userId,
        token_hash: 'h',
        session_id: randomUUID(),
        expires_at: new Date(now() + 3_600_000),
        client: 'cashier',
        business_id: bizA,
        branch_id: null,
        device_label: null,
        ...over,
      };
      const cols = Object.keys(r);
      await c.query(
        `insert into refresh_tokens (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(r),
      );
      return r as { id: string; session_id: string };
    };
    const live = async (sid: string) =>
      (
        await c.query(`select 1 from refresh_tokens where session_id=$1 and revoked_at is null`, [
          sid,
        ])
      ).rowCount === 1;

    beforeAll(async () => {
      c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      repos = createRepositories(buildDb(c as never));
      userId = (
        await c.query(
          `insert into users (email, password_hash, full_name) values ($1,'x','Pat') returning id`,
          [`c6-${randomUUID()}@example.test`],
        )
      ).rows[0].id;
      bizA = (
        await c.query(`insert into businesses (name, slug) values ('A',$1) returning id`, [
          `a-${randomUUID()}`,
        ])
      ).rows[0].id;
      bizB = (
        await c.query(`insert into businesses (name, slug) values ('B',$1) returning id`, [
          `b-${randomUUID()}`,
        ])
      ).rows[0].id;
      branchA = (
        await c.query(
          `insert into branches (business_id, name, slug) values ($1,'Main',$2) returning id`,
          [bizA, `m-${randomUUID()}`],
        )
      ).rows[0].id;
    });
    afterAll(async () => {
      await c?.end();
    });

    it('lists only live cashier sessions of the named business', async () => {
      const mine = await row({ branch_id: branchA, device_label: 'Counter 1' });
      const foreign = await row({ business_id: bizB });
      const web = await row({ client: 'web', business_id: null });
      const revoked = await row({ revoked_at: new Date() });
      const expired = await row({ expires_at: new Date(now() - 1000) });
      const ids = (await repos.refreshTokens.listLiveCashierSessionsForBusiness(bizA, now())).map(
        (r) => r.sessionId,
      );
      expect(ids).toContain(mine.session_id);
      for (const other of [foreign, web, revoked, expired]) {
        expect(ids).not.toContain(other.session_id);
      }
      const own = (
        await repos.refreshTokens.listLiveCashierSessionsForBusiness(bizA, now())
      ).find((r) => r.sessionId === mine.session_id)!;
      expect(own).toMatchObject({ userName: 'Pat', branchName: 'Main', deviceLabel: 'Counter 1' });
      const idsB = (await repos.refreshTokens.listLiveCashierSessionsForBusiness(bizB, now())).map(
        (r) => r.sessionId,
      );
      expect(idsB).toContain(foreign.session_id);
      expect(idsB).not.toContain(mine.session_id);
    });

    it('revokes one session only inside its own business, and never a web session', async () => {
      const mine = await row({});
      const foreign = await row({ business_id: bizB });
      const web = await row({ client: 'web', business_id: null });
      expect(await repos.refreshTokens.revokeCashierSession(bizA, foreign.session_id)).toBeNull();
      expect(await repos.refreshTokens.revokeCashierSession(bizA, web.session_id)).toBeNull();
      expect(await live(foreign.session_id)).toBe(true);
      expect(await live(web.session_id)).toBe(true);
      expect(
        await repos.refreshTokens.revokeCashierSession(bizA, mine.session_id),
      ).toMatchObject({ userId });
      expect(await live(mine.session_id)).toBe(false);
      expect(await repos.refreshTokens.revokeCashierSession(bizA, mine.session_id)).toBeNull();
      // A revoked session is not live for the access-token check either.
      expect(await repos.refreshTokens.isSessionLive(userId, mine.session_id, now())).toBe(false);
    });

    it("revoke-all ends only that business's cashier sessions", async () => {
      const a1 = await row({});
      const a2 = await row({});
      const b1 = await row({ business_id: bizB });
      const web = await row({ client: 'web', business_id: null });
      const n = await repos.refreshTokens.revokeAllCashierSessionsForBusiness(bizA);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(await live(a1.session_id)).toBe(false);
      expect(await live(a2.session_id)).toBe(false);
      expect(await live(b1.session_id)).toBe(true);
      expect(await live(web.session_id)).toBe(true);
    });
  },
);
