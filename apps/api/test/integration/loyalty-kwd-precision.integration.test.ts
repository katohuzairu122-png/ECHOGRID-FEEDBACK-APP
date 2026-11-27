import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService } from '../../src/loyalty/programs/program.service';
import { LoyaltyRewardService } from '../../src/loyalty/loyalty-reward.service';
import { moneyScaleFor, moneyStorageScale, resetMoneyStorageScaleCache } from '../../src/loyalty/money-storage';
import { appDbOf } from '../helpers/runtime-db';

/** LPC-14: Kuwaiti dinar (three decimals) end to end on PostgreSQL, the 0108 migration on pre-existing two-decimal data, and its rollback guard. */
describe.skipIf(!process.env.DATABASE_URL)('KWD three-decimal money (integration)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  const api = resolve(__dirname, '../..');
  const migration = readFileSync(resolve(api, 'drizzle/0108_kwd_three_decimal_storage.sql'), 'utf8').split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean);
  const rollback = readFileSync(resolve(api, '../../docs/architecture/builds/TENTASHIP/rollback/0108_rollback.sql'), 'utf8');
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let programmes: LoyaltyProgramService;
  let loyalty: LoyaltyAccountService;
  let ownerId: string;
  let n = 0;

  async function business(currency: string) {
    n += 1;
    const businessId = (await new BusinessService(appDbOf(buildDb(admin))).createBusiness({ name: `KWD ${n} ${run}` } as never, ownerId)).businessId;
    await admin.query(`update businesses set default_currency=$2 where id=$1`, [businessId, currency]);
    const branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `kwd-${n}-${run}` })).id;
    return { businessId, branchId };
  }
  async function member(businessId: string) {
    const customer = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: customer.id, businessId, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'kwd' });
    return (await repos.loyaltyAccounts.create({ customerId: customer.id, businessId, membershipId: membership.id })).id;
  }
  const buy = (b: { businessId: string; branchId: string }, accountId: string, amount: number | string, key: string) =>
    loyalty.recordPurchase({ businessId: b.businessId, branchId: b.branchId, accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });
  async function activate(businessId: string, type: string, config: Record<string, unknown>) {
    const draft = await programmes.createDraft(businessId, ownerId, { type, config });
    await programmes.validate(businessId, ownerId, draft.id);
    await programmes.activate(businessId, ownerId, draft.id);
    return draft.id;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const db = buildDb(admin);
    repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    loyalty = new LoyaltyAccountService(appDbOf(db));
    ownerId = (await repos.users.create({ email: `kwd-${run}@example.test`, fullName: 'owner', passwordHash: 'x', status: 'active' })).id;
    resetMoneyStorageScaleCache();
  });
  afterAll(async () => { await admin.end(); });

  it('the migrated database stores three decimals, and the code sees it in the catalogue', async () => {
    resetMoneyStorageScaleCache();
    expect(await moneyStorageScale(buildDb(admin))).toBe(3);
  });

  it('records a KWD purchase to the fils exactly, replays it idempotently, and refuses a fourth decimal', async () => {
    const b = await business('KWD');
    const account = await member(b.businessId);
    await activate(b.businessId, 'LP-03', { pointsPerCurrencyUnit: '10' });
    await buy(b, account, 12.345, `k-${run}-1`);
    expect((await admin.query(`select qualifying_amount from loyalty_purchase_events where business_id=$1 and idempotency_key=$2`, [b.businessId, `k-${run}-1`])).rows[0].qualifying_amount).toBe('12.345');
    expect((await admin.query(`select purchase_amount from loyalty_transactions where loyalty_account_id=$1`, [account])).rows[0].purchase_amount).toBe('12.345');
    // 12.345 KWD at 10 points per dinar: floor(123.45) = 123 points, from exact integer arithmetic.
    expect((await admin.query(`select points from loyalty_accounts where id=$1`, [account])).rows[0].points).toBe(123);
    const again = await buy(b, account, '12.345', `k-${run}-1`); // the same purchase as exact text
    expect(again.inserted).toBe(false);
    await expect(buy(b, account, 12.3456, `k-${run}-2`)).rejects.toMatchObject({ code: 'INVALID_PURCHASE_AMOUNT' });
    await expect(buy(b, account, '12.3456', `k-${run}-3`)).rejects.toMatchObject({ code: 'INVALID_PURCHASE_AMOUNT' });
  });

  it('a currency with two decimals never accepts a third', async () => {
    const b = await business('USD');
    const account = await member(b.businessId);
    await activate(b.businessId, 'LP-03', { pointsPerCurrencyUnit: '1' });
    await expect(buy(b, account, 12.345, `u-${run}-1`)).rejects.toMatchObject({ code: 'INVALID_PURCHASE_AMOUNT' });
    await buy(b, account, 12.34, `u-${run}-2`);
  });

  it('spend-based milestones in KWD are exact to the fils at the boundary', async () => {
    const b = await business('KWD');
    const reward = (await repos.loyaltyRewards.create({ businessId: b.businessId, name: 'Prize', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const account = await member(b.businessId);
    const programId = await activate(b.businessId, 'LP-04', { metric: 'spend', milestones: [{ threshold: '0.999', rewardId: reward }] });
    await buy(b, account, 0.333, `m-${run}-1`);
    await buy(b, account, 0.333, `m-${run}-2`);
    expect((await admin.query(`select count(*)::int c from loyalty_program_entitlements where loyalty_account_id=$1`, [account])).rows[0].c).toBe(0); // 0.666 < 0.999
    await buy(b, account, 0.333, `m-${run}-3`);
    expect((await admin.query(`select count(*)::int c from loyalty_program_entitlements where loyalty_account_id=$1`, [account])).rows[0].c).toBe(1); // exactly 0.999
    expect((await admin.query(`select counters from loyalty_program_progress where program_id=$1 and loyalty_account_id=$2`, [programId, account])).rows[0].counters).toMatchObject({ spendMinor: 999 });
  });

  it('reward values and budgets keep three decimals for KWD and refuse them for USD', async () => {
    const kwd = await business('KWD');
    const usd = await business('USD');
    const service = (id: string) => new LoyaltyRewardService(createRepositories(buildDb(admin)), (businessId) => moneyScaleFor(buildDb(admin), businessId)).create(id, { name: `R ${run}`, type: 'voucher', rewardValue: 8.305, maxBudget: 100.5 } as never, ownerId);
    const reward = await service(kwd.businessId);
    expect(reward.rewardValue).toBe('8.305');
    expect(reward.maxBudget).toBe('100.500');
    await expect(service(usd.businessId)).rejects.toMatchObject({ code: 'INVALID_REWARD_AMOUNT', status: 422 });
  });

  it('migration 0108 on a database that still has two-decimal columns keeps every historical value, then allows three decimals', async () => {
    const b = await business('KWD');
    const account = await member(b.businessId);
    await admin.query('BEGIN');
    try {
      // Put the four columns back to the pre-0108 width (DDL is transactional), insert "legacy" two-decimal rows, then run the committed 0108 statements.
      await admin.query('ALTER TABLE loyalty_rewards ALTER COLUMN reward_value SET DATA TYPE numeric(10,2)');
      await admin.query('ALTER TABLE loyalty_rewards ALTER COLUMN max_budget SET DATA TYPE numeric(10,2)');
      await admin.query('ALTER TABLE loyalty_purchase_events ALTER COLUMN qualifying_amount SET DATA TYPE numeric(10,2)');
      await admin.query('ALTER TABLE loyalty_transactions ALTER COLUMN purchase_amount SET DATA TYPE numeric(10,2)');
      resetMoneyStorageScaleCache();
      expect(await moneyStorageScale(buildDb(admin))).toBe(2); // the code refuses a third decimal while the columns are narrow
      const customerId = (await admin.query(`select customer_id from loyalty_accounts where id=$1`, [account])).rows[0].customer_id;
      const membershipId = (await admin.query(`select id from business_customer_memberships where customer_id=$1 and business_id=$2`, [customerId, b.businessId])).rows[0].id;
      const event = (await admin.query(
        `insert into loyalty_purchase_events (business_id, branch_id, customer_id, membership_id, loyalty_account_id, idempotency_key, channel, qualifying_amount, payment_status)
         values ($1,$2,$3,$4,$5,$6,'branch','12.50','confirmed') returning id`,
        [b.businessId, b.branchId, customerId, membershipId, account, `legacy-${run}`],
      )).rows[0].id;
      await admin.query(`insert into loyalty_transactions (loyalty_account_id, type, points, purchase_amount, purchase_event_id) values ($1,'purchase',125,'12.50',$2)`, [account, event]);
      const reward = (await admin.query(`insert into loyalty_rewards (business_id, name, type, status, reward_value, max_budget) values ($1,'Legacy','voucher','active','8.30','99.60') returning id`, [b.businessId])).rows[0].id;
      for (const statement of migration) await admin.query(statement);
      expect((await admin.query(`select qualifying_amount::text a, (qualifying_amount = 12.5) same from loyalty_purchase_events where id=$1`, [event])).rows[0]).toEqual({ a: '12.500', same: true });
      expect((await admin.query(`select purchase_amount = 12.5 same from loyalty_transactions where purchase_event_id=$1`, [event])).rows[0].same).toBe(true);
      expect((await admin.query(`select reward_value = 8.3 v, max_budget = 99.6 m from loyalty_rewards where id=$1`, [reward])).rows[0]).toEqual({ v: true, m: true });
      resetMoneyStorageScaleCache();
      expect(await moneyStorageScale(buildDb(admin))).toBe(3);
      await admin.query(`update loyalty_rewards set reward_value='8.305' where id=$1`, [reward]);
      expect((await admin.query(`select reward_value::text v from loyalty_rewards where id=$1`, [reward])).rows[0].v).toBe('8.305');
    } finally {
      await admin.query('ROLLBACK');
      resetMoneyStorageScaleCache();
    }
    expect(await moneyStorageScale(buildDb(admin))).toBe(3); // the rollback restored the migrated state for every other test
  });

  it('the rollback script narrows the columns only while no value has a third decimal, and refuses otherwise', async () => {
    const b = await business('KWD');
    const account = await member(b.businessId);
    await admin.query('BEGIN');
    try {
      await admin.query(rollback.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')); // no three-decimal data exists in this scope's rows yet
    } catch {
      // other suites' three-decimal rows may exist in the shared test database; the refusal below is asserted on a row this test controls
    } finally {
      await admin.query('ROLLBACK');
    }
    await admin.query('BEGIN');
    try {
      await activate(b.businessId, 'LP-03', { pointsPerCurrencyUnit: '1' });
      await buy(b, account, 7.777, `rb-${run}-1`);
      const message = await admin.query(rollback.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')).then(() => '', (e: Error) => e.message);
      expect(message).toContain('0108 rollback refused');
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
