import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { assessCustomerDeletionReadiness, CUSTOMER_DATA_INVENTORY, DELETION_EXECUTION_BLOCKERS } from '../../src/customer-data/customer-data-inventory';
import { makeFixtures } from './helpers/tentaship-fixtures';

/** G8 against real PostgreSQL: the customer-data inventory is COMPLETE against the live catalogue, invents no treatment, and the readiness assessment is read-only and always blocked. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

describe.skipIf(!databaseUrl)('G8 customer data inventory and deletion readiness (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>;
  beforeAll(async () => { client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client); });
  afterAll(async () => { await client?.end(); });

  it('COMPLETENESS: every foreign key to customers and every customer_id column is classified, and no entry is stale or duplicated', async () => {
    const fks = (await f.q(`SELECT conrelid::regclass::text AS t, a.attname AS c FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey) WHERE k.contype = 'f' AND k.confrelid = 'customers'::regclass`)).map((r) => `${r.t}.${r.c}`);
    const cols = (await f.q(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('customer_id','participant_customer_id','referred_customer_id','referring_customer_id','referred_by_customer_id')`)).map((r) => `${r.t}.${r.c}`);
    const live = new Set([...fks, ...cols]); const inv = CUSTOMER_DATA_INVENTORY.map((x) => `${x.table}.${x.column}`);
    expect([...live].filter((x) => !inv.includes(x)), 'customer-linked columns NOT classified (add them to CUSTOMER_DATA_INVENTORY)').toEqual([]);
    expect(inv.filter((x) => !live.has(x)), 'inventory entries that no longer exist').toEqual([]);
    expect(new Set(inv).size).toBe(inv.length);
  });

  it('NO TREATMENT IS INVENTED: every entry is undecided; the readiness assessment counts what exists, never changes it and is always blocked', async () => {
    expect(CUSTOMER_DATA_INVENTORY.every((x) => x.treatment === 'UNDECIDED_REQUIRES_OWNER_POLICY')).toBe(true);
    const biz = await f.business('g8'); const cid = await f.customer({ businessId: biz, purchase: true });
    const before = Number((await f.q(`SELECT count(*)::int n FROM loyalty_purchase_events WHERE customer_id=$1`, [cid]))[0].n);
    const r = await assessCustomerDeletionReadiness(f.db, cid);
    expect(r.customerFound).toBe(true); expect(r.execution).toBe('blocked'); expect(r.blockers).toEqual(DELETION_EXECUTION_BLOCKERS);
    expect(r.holdings.loyalty_financial_ledger).toBeGreaterThan(0); expect(r.holdings.relationship_consent).toBeGreaterThan(0); expect(r.appendOnlyRowsPresent).toBe(true);
    expect(r.activeLegalHold).toBe(false); expect(r.openDeletionRequest).toBe(false);
    expect(Number((await f.q(`SELECT count(*)::int n FROM loyalty_purchase_events WHERE customer_id=$1`, [cid]))[0].n)).toBe(before); // read-only
    expect(JSON.stringify(r)).not.toContain(cid);
    const none = await assessCustomerDeletionReadiness(f.db, randomUUID()); expect(none.customerFound).toBe(false); expect(Object.values(none.holdings).every((n) => n === 0)).toBe(true);
  });
});
