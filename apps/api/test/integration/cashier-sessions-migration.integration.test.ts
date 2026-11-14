import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * CASHIER-PWA-01 C3 migration 0071 on a SCRATCH database (DATABASE_URL, never production): the refresh_tokens
 * binding columns and their constraints.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'migration 0071 cashier sessions (integration, scratch database)',
  () => {
    let c: Client;
    let userId: string;
    let businessId: string;
    let branchId: string;

    const insert = (over: Record<string, unknown>) => {
      const row = {
        id: randomUUID(),
        user_id: userId,
        token_hash: 'h',
        session_id: randomUUID(),
        expires_at: new Date(Date.now() + 3600_000),
        client: 'web',
        business_id: null,
        branch_id: null,
        device_label: null,
        ...over,
      };
      const cols = Object.keys(row);
      return c.query(
        `insert into refresh_tokens (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(row),
      );
    };

    beforeAll(async () => {
      c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      userId = (
        await c.query(
          `insert into users (email, password_hash, full_name) values ($1,'x','T') returning id`,
          [`c3-${randomUUID()}@example.test`],
        )
      ).rows[0].id;
      businessId = (
        await c.query(`insert into businesses (name, slug) values ('B',$1) returning id`, [
          `b-${randomUUID()}`,
        ])
      ).rows[0].id;
      branchId = (
        await c.query(
          `insert into branches (business_id, name, slug) values ($1,'Br',$2) returning id`,
          [businessId, `br-${randomUUID()}`],
        )
      ).rows[0].id;
    });
    afterAll(async () => {
      await c?.end();
    });

    it('existing-style rows default to a web session with no binding', async () => {
      const id = randomUUID();
      await c.query(
        `insert into refresh_tokens (id, user_id, token_hash, expires_at) values ($1,$2,'h', now() + interval '1 hour')`,
        [id, userId],
      );
      const row = (
        await c.query(
          `select client, business_id, branch_id, device_label from refresh_tokens where id=$1`,
          [id],
        )
      ).rows[0];
      expect(row).toEqual({
        client: 'web',
        business_id: null,
        branch_id: null,
        device_label: null,
      });
    });

    it('accepts a cashier row bound to a business, with or without a branch, and a device label', async () => {
      await expect(
        insert({ client: 'cashier', business_id: businessId, device_label: 'Counter 1' }),
      ).resolves.toBeTruthy();
      await expect(
        insert({ client: 'cashier', business_id: businessId, branch_id: branchId }),
      ).resolves.toBeTruthy();
    });

    it('refuses a cashier row without a business, a web row with a binding, an unknown client, and bad labels', async () => {
      await expect(insert({ client: 'cashier' })).rejects.toThrow(
        /refresh_tokens_cashier_binding_check/,
      );
      await expect(insert({ client: 'web', business_id: businessId })).rejects.toThrow(
        /refresh_tokens_cashier_binding_check/,
      );
      await expect(insert({ client: 'web', branch_id: branchId })).rejects.toThrow(
        /refresh_tokens_cashier_binding_check/,
      );
      // Rejected by whichever check the database evaluates first (the binding check also fails for an unknown client).
      await expect(insert({ client: 'kiosk' })).rejects.toThrow(
        /refresh_tokens_(client|cashier_binding)_check/,
      );
      await expect(insert({ client: 'kiosk', business_id: businessId })).rejects.toThrow(
        /refresh_tokens_(client|cashier_binding)_check/,
      );
      await expect(
        insert({ client: 'cashier', business_id: businessId, device_label: '   ' }),
      ).rejects.toThrow(/refresh_tokens_device_label_check/);
      await expect(
        insert({ client: 'cashier', business_id: businessId, device_label: 'x'.repeat(81) }),
      ).rejects.toThrow(/refresh_tokens_device_label_check/);
    });

    it('refuses a binding to a business or branch that does not exist', async () => {
      await expect(insert({ client: 'cashier', business_id: randomUUID() })).rejects.toThrow(
        /foreign key/i,
      );
      await expect(
        insert({ client: 'cashier', business_id: businessId, branch_id: randomUUID() }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('removing a business removes its cashier sessions', async () => {
      const biz = (
        await c.query(`insert into businesses (name, slug) values ('Gone',$1) returning id`, [
          `g-${randomUUID()}`,
        ])
      ).rows[0].id;
      const id = randomUUID();
      await insert({ id, client: 'cashier', business_id: biz });
      await c.query(`delete from businesses where id=$1`, [biz]);
      expect((await c.query(`select 1 from refresh_tokens where id=$1`, [id])).rowCount).toBe(0);
    });
  },
);
