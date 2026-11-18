import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyRedemptionService } from '../../src/loyalty/loyalty-redemption.service';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';

const url = process.env.DATABASE_URL;
if (url && (!['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !['/echogrid_test', '/echogrid_ci_pg18'].includes(new URL(url).pathname))) {
  throw new Error('Split 01 security acceptance requires a disposable loopback test database.');
}

describe.skipIf(!url)('Split 01 security acceptance with real transaction races', () => {
  const client = new Client({ connectionString: url });
  let businessId: string;
  let staffId: string;
  let pointsReward: string;
  let voucher: string;
  let repos: ReturnType<typeof createRepositories>;
  let accounts: LoyaltyAccountService;

  beforeAll(async () => {
    await client.connect();
    repos = createRepositories(buildDb(client));
    accounts = new LoyaltyAccountService(buildDb(client));
    const tag = randomUUID();
    businessId = (await repos.businesses.create({ name: 'Split 01 security', slug: 's01-security-' + tag })).id;
    staffId = (await repos.users.create({ email: tag + '@example.test', fullName: 'Security fixture', passwordHash: 'synthetic', status: 'active' })).id;
    pointsReward = (await repos.loyaltyRewards.create({ businessId, name: 'Security points fixture', pointsCost: 10 })).id;
    voucher = (await repos.loyaltyRewards.create({ businessId, name: 'Security voucher fixture', type: 'voucher', rewardValue: '5.00' })).id;
  });
  afterAll(async () => { await client.end(); });

  async function fixture(status = 'active', accountStatus = 'active') {
    const customerId = (await repos.customers.create({ phone: '+1587' + String(Math.floor(Math.random() * 9000000 + 1000000)), phoneVerifiedAt: new Date() })).id;
    const joined = await new CustomerMembershipService(buildDb(client)).join({ customerId, businessId, onboardingSource: 'business_qr', onboardingReference: 'synthetic-security-fixture', consentAccepted: true, consentVersion: 'v1' });
    await client.query('update loyalty_accounts set points=100,status=$2 where id=$1', [joined.loyaltyAccount.id, accountStatus]);
    if (status === 'missing') {
      await client.query('update loyalty_accounts set membership_id=null where id=$1', [joined.loyaltyAccount.id]);
      await client.query('delete from business_customer_memberships where id=$1', [joined.membership.id]);
    } else if (status !== 'active') {
      await client.query('update business_customer_memberships set status=$2 where id=$1', [joined.membership.id, status]);
    }
    return { customerId, accountId: joined.loyaltyAccount.id, membershipId: joined.membership.id };
  }
  async function snapshot(accountId: string) {
    return (await client.query(`select points,(select count(*)::int from loyalty_transactions where loyalty_account_id=a.id) ledger,
      (select count(*)::int from loyalty_purchase_events where loyalty_account_id=a.id) purchases from loyalty_accounts a where id=$1`, [accountId])).rows[0];
  }
  const purchase = (service: LoyaltyAccountService, accountId: string) => service.recordPurchase({ businessId, accountId, purchaseAmount: 10, idempotencyKey: randomUUID(), channel: 'branch', staffUserId: staffId });

  it.each(['left', 'suspended', 'pending', 'business_exited', 'closed', 'missing'])('positive adjustment refuses %s membership without touching economics', async status => {
    const f = await fixture(status);
    const before = await snapshot(f.accountId);
    await expect(accounts.adjustPoints(businessId, f.accountId, 5, 'security regression', staffId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await snapshot(f.accountId)).toEqual(before);
  });
  it.each(['left', 'suspended', 'missing'])('purchase refuses %s membership without purchase or ledger evidence', async status => {
    const f = await fixture(status);
    const before = await snapshot(f.accountId);
    await expect(purchase(accounts, f.accountId)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await snapshot(f.accountId)).toEqual(before);
  });
  it.each(['adjustment', 'purchase'])('%s refuses a suspended loyalty account with an active membership', async method => {
    const f = await fixture('active', 'suspended');
    const before = await snapshot(f.accountId);
    const work = method === 'purchase' ? purchase(accounts, f.accountId) : accounts.adjustPoints(businessId, f.accountId, 5, 'security regression', staffId);
    await expect(work).rejects.toMatchObject({ code: 'MEMBERSHIP_SUSPENDED' });
    expect(await snapshot(f.accountId)).toEqual(before);
  });

  it.each(['redeem', 'issue'] as const)('a committed suspension during the membership wait denies %s, not just confirmation', async method => {
    const f = await fixture();
    const blocker = new Client({ connectionString: url });
    const operation = new Client({ connectionString: url });
    await blocker.connect(); await operation.connect();
    const before = await snapshot(f.accountId);
    let pending: Promise<unknown> | undefined;
    try {
      await operation.query("set statement_timeout='5s'");
      await blocker.query('begin');
      await blocker.query('update business_customer_memberships set updated_at=now() where id=$1', [f.membershipId]);
      await blocker.query("update loyalty_accounts set status='suspended' where id=$1", [f.accountId]);
      const pid = (await operation.query('select pg_backend_pid() pid')).rows[0].pid as number;
      const service = new LoyaltyRedemptionService(buildDb(operation));
      pending = service[method](f.customerId, businessId, method === 'redeem' ? pointsReward : voucher).then(value => ({ value }), error => ({ error }));
      await vi.waitFor(async () => {
        expect((await client.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type).toBe('Lock');
      }, { timeout: 2000, interval: 20 });
      await blocker.query('commit');
      expect(await pending).toMatchObject({ error: { code: 'MEMBERSHIP_SUSPENDED' } });
      expect(await snapshot(f.accountId)).toEqual(before);
    } finally {
      await blocker.query('rollback');
      await pending;
      await blocker.end(); await operation.end();
    }
  });
});
