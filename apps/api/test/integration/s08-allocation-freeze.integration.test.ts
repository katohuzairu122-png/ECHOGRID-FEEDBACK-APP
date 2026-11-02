import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/** Synthetic guard checks on local disposable PostgreSQL; migrated guards remain installed; fixtures roll back. */
describe.skipIf(!process.env.DATABASE_URL)(
  'S08-DEV-05 inert allocation freeze schema (disposable PostgreSQL)',
  () => {
    it('rejects migrated parent and child writes and rolls back fixtures', async () => {
      const target = new URL(process.env.DATABASE_URL!);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
        !/^echogrid_(test|s08_|ci_|scratch_)/.test(decodeURIComponent(target.pathname.slice(1)))
      ) {
        throw new Error('S08 freeze contract requires local disposable PostgreSQL');
      }
      const client = new Client({ connectionString: target.toString() });
      await client.connect();
      try {
        await client.query('BEGIN');
        const business = (
          await client.query<{ id: string }>(
            "insert into businesses(name,slug,status) values('Inert guard fixture',$1,'active') returning id",
            [randomUUID()],
          )
        ).rows[0]!.id;
        await client.query('SAVEPOINT parent_guard');
        await expect(
          client.query(
            "insert into s08_allocation_freezes (business_id,invoice_ref,currency,policy_version,allocation_digest,aggregate_benefit_minor,reservation_count,artifact) values($1,'in_test','usd','S08-AGG-ROUND/1',$2,3,2,'{}'::jsonb)",
            [business, 'a'.repeat(64)],
          ),
        ).rejects.toThrow(/S08_ALLOCATION_INERT/);
        await client.query('ROLLBACK TO SAVEPOINT parent_guard');
        await client.query('SAVEPOINT child_guard');
        await expect(
          client.query(
            "insert into s08_allocation_freeze_items (freeze_id,business_id,reservation_id,invoice_intent_ref,benefit_minor,provider_idempotency_key) values($1,$2,$3,'intent_guard',1,'guard_key')",
            [randomUUID(), business, randomUUID()],
          ),
        ).rejects.toThrow(/S08_ALLOCATION_INERT/);
        await client.query('ROLLBACK TO SAVEPOINT child_guard');
        const triggers = await client.query<{ tgname: string; enabled: string }>(
          "select tgname,tgenabled enabled from pg_trigger where tgname in ('s08_allocation_parent_deny','s08_allocation_child_deny') order by tgname",
        );
        expect(triggers.rows).toEqual([
          { tgname: 's08_allocation_child_deny', enabled: 'O' },
          { tgname: 's08_allocation_parent_deny', enabled: 'O' },
        ]);
        await client.query('ROLLBACK');
        expect(
          (
            await client.query(
              "select to_regclass('s08_allocation_freezes') parent, to_regclass('s08_allocation_freeze_items') child",
            )
          ).rows[0],
        ).toEqual({ parent: 's08_allocation_freezes', child: 's08_allocation_freeze_items' });
        expect(
          (await client.query('select id from businesses where id=$1', [business])).rowCount,
        ).toBe(0);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    });
  },
);
