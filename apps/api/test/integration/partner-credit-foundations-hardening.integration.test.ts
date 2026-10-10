import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

async function assertRejected(promise: Promise<unknown>, contains: string): Promise<void> {
  await expect(promise).rejects.toThrow(contains);
}

describe.skipIf(!process.env.DATABASE_URL)('Split 07 Block 1 PostgreSQL hardening', () => {
  let client: Client;
  let businessId: string;
  let accountId: string;
  let policyId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const business = await client.query<{ id: string }>(
      "INSERT INTO businesses(name,slug) VALUES($1,$2) RETURNING id",
      ['Split07 Foundation Test', 'split07-hardening-' + crypto.randomUUID()],
    );
    businessId = business.rows[0]!.id;
  });
  afterAll(async () => { await client?.end(); });

  it('creates zero-only account and rejects a second account for the same business', async () => {
    const a = await client.query<{ id: string }>('INSERT INTO partner_credit_accounts(business_id) VALUES($1) RETURNING id', [businessId]);
    accountId = a.rows[0]!.id;
    await expect(client.query('INSERT INTO partner_credit_accounts(business_id) VALUES($1)', [businessId]))
      .rejects.toMatchObject({ code: '23505' });
    await assertRejected(client.query('INSERT INTO partner_credit_accounts(business_id,available) VALUES($1,1)', [businessId]), 'Partner Credit accounts must initialize at zero');
  });

  it('blocks projection updates and deletes even when balances would stay nonnegative', async () => {
    await assertRejected(client.query('UPDATE partner_credit_accounts SET provisional=1 WHERE id=$1', [accountId]), 'projection mutations disabled');
    await assertRejected(client.query('DELETE FROM partner_credit_accounts WHERE id=$1', [accountId]), 'projection mutations disabled');
  });

  it('blocks economic ledger and lot issuance before Block 2 activation', async () => {
    await assertRejected(client.query("INSERT INTO partner_credit_ledger(account_id,entry_type,units,idempotency_key) VALUES($1,'provisional',1,$2)", [accountId,crypto.randomUUID()]), 'economic issuance disabled');
  });

  it('protects published economic policies from mutation while allowing draft policy edits', async () => {
    const version = 'PC-TEST-' + crypto.randomUUID();
    const p = await client.query<{ id: string }>("INSERT INTO partner_credit_policies(version,state) VALUES($1,'draft') RETURNING id", [version]);
    policyId = p.rows[0]!.id;
    await client.query('UPDATE partner_credit_policies SET monthly_cap=9 WHERE id=$1', [policyId]);
    await client.query("UPDATE partner_credit_policies SET state='retired' WHERE id=$1", [policyId]);
    await assertRejected(client.query('UPDATE partner_credit_policies SET monthly_cap=11 WHERE id=$1', [policyId]), 'Published Partner Credit policy economics cannot be modified');
  });

  it('keeps Block 1 permission distinct from ordinary settlement and billing permissions', async () => {
    const x = await client.query<{ key: string }>("SELECT key FROM permissions WHERE key='partner_credits:view'");
    expect(x.rows.length).toBe(1);
    const granted = await client.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.key='partner_credits:view'",
    );
    // The permission is intentionally not mass-granted in Block 1.
    expect(Number(granted.rows[0]!.total)).toBe(0);
  });
});
