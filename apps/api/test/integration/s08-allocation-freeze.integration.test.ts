import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

/**
 * Contract characterization only: executes the proposed freeze DDL against a
 * disposable PostgreSQL transaction and rolls it back. The candidate remains
 * outside Drizzle migrations. No production database or financial permissions.
 */
describe.skipIf(!process.env.DATABASE_URL)('S08-DEV-05 inert allocation freeze schema (disposable PostgreSQL)', () => {
  it('rejects all writes with guards enabled and rolls back the DDL', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      // Existing schema is required; a separate dedicated scratch DB is mandatory.
      const dbName = (await client.query<{ name: string }>('select current_database() name')).rows[0]?.name ?? '';
      if (!/^echogrid_(test|s08_|ci_|scratch_)/.test(dbName)) {
        throw new Error('S08 freeze contract must run on an explicitly disposable database');
      }
      const ddl = readFileSync(resolve(__dirname, '../../scripts/sql/s08-allocation-freeze.candidate.sql'), 'utf8');
      await client.query(ddl);
      const business = (await client.query<{ id: string }>('select id from businesses limit 1')).rows[0]?.id;
      if (business) {
        await expect(client.query(
          `insert into s08_allocation_freezes
           (business_id, invoice_ref, currency, policy_version, allocation_digest, aggregate_benefit_minor, reservation_count, artifact)
           values($1,'in_test','usd','S08-AGG-ROUND/1',$2,3,2,'{}'::jsonb)`,
          [business, 'a'.repeat(64)],
        )).rejects.toThrow(/S08_ALLOCATION_INERT/);
      }
      // The guard remains the acceptance criterion even with no businesses.
      const trigger = await client.query<{ enabled: string }>(
        `select t.tgenabled enabled from pg_trigger t
         where t.tgrelid='s08_allocation_freezes'::regclass and t.tgname='s08_allocation_parent_deny'`,
      );
      expect(trigger.rows[0]?.enabled).toBe('O');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
