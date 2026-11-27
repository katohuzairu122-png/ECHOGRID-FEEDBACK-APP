import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService } from '../../src/loyalty/programs/program.service';
import { consumeEntitlement } from '../../src/loyalty/programs/stamp.service';
import { listAvailableEntitlements, redeemAccountEntitlement } from '../../src/loyalty/programs/entitlement.service';
import { customerProgrammeCard } from '../../src/loyalty/programs/programme-card.service';
import { appDbOf } from '../helpers/runtime-db';

/** LP-01 Buy X, get Y free: stamp card behaviour on a disposable PostgreSQL database (RW-D4). */
describe.skipIf(!process.env.DATABASE_URL)('LP-01 stamp card (integration)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  let admin: Client;
  let raceA: Client;
  let raceB: Client;
  let repos: ReturnType<typeof createRepositories>;
  let programmes: LoyaltyProgramService;
  let loyalty: LoyaltyAccountService;
  let ownerId: string;
  let businessId: string;
  let otherBusinessId: string;
  let branchId: string;
  let rewardId: string;
  let programId: string;

  const buy = (service: LoyaltyAccountService, accountId: string, amount: number, key: string) =>
    service.recordPurchase({ businessId, branchId, accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });
  async function member() {
    const customer = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: customer.id, businessId, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'lp01' });
    const account = await repos.loyaltyAccounts.create({ customerId: customer.id, businessId, membershipId: membership.id });
    return account.id;
  }
  /** Runs `fn` with `count` independent connections, so the calls genuinely race instead of queueing on one connection. */
  async function race<T>(count: number, fn: (service: LoyaltyAccountService, index: number) => Promise<T>): Promise<T[]> {
    const clients = await Promise.all(Array.from({ length: count }, async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      return client;
    }));
    try {
      return await Promise.all(clients.map((client, index) => fn(new LoyaltyAccountService(buildDb(client)), index)));
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }
  const progress = async (accountId: string) => (await admin.query(`select counters from loyalty_program_progress where program_id=$1 and loyalty_account_id=$2`, [programId, accountId])).rows[0]?.counters;
  const entitlements = async (accountId: string) => (await admin.query(`select source_key, status, reward_id from loyalty_program_entitlements where loyalty_account_id=$1 order by earned_at, source_key`, [accountId])).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    raceA = new Client({ connectionString: process.env.DATABASE_URL });
    raceB = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([admin.connect(), raceA.connect(), raceB.connect()]);
    const db = buildDb(admin);
    repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    loyalty = new LoyaltyAccountService(appDbOf(db));
    ownerId = (await repos.users.create({ email: `lp01-owner-${run}@example.test`, fullName: 'owner', passwordHash: 'x', status: 'active' })).id;
    businessId = (await new BusinessService(appDbOf(db)).createBusiness({ name: `LP01 ${run}` } as never, ownerId)).businessId;
    otherBusinessId = (await new BusinessService(appDbOf(db)).createBusiness({ name: `LP01 other ${run}` } as never, ownerId)).businessId;
    branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `lp01-${run}` })).id;
    rewardId = (await repos.loyaltyRewards.create({ businessId, name: 'Free coffee', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const draft = await programmes.createDraft(businessId, ownerId, {
      type: 'LP-01',
      config: { stampThreshold: 3, rewardId, stampExpiryDays: 30, resetPolicy: 'on_completion', minimumPurchaseAmount: '2.00' },
    });
    programId = draft.id;
    await programmes.validate(businessId, ownerId, draft.id);
    await programmes.activate(businessId, ownerId, draft.id);
  });

  afterAll(async () => {
    await Promise.all([admin.end(), raceA.end(), raceB.end()]);
  });

  it('only accepts a free-item reward of THIS business, and expiry and reset must be stated', async () => {
    const pointsReward = (await repos.loyaltyRewards.create({ businessId, name: 'Points reward', type: 'points', pointsCost: 10, status: 'active', createdBy: ownerId } as never)).id;
    const foreignReward = (await repos.loyaltyRewards.create({ businessId: otherBusinessId, name: 'Foreign', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const base = { stampThreshold: 3, stampExpiryDays: null, resetPolicy: 'on_completion' };
    for (const bad of [pointsReward, foreignReward, crypto.randomUUID()]) {
      await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-01', config: { ...base, rewardId: bad } })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID', details: [expect.objectContaining({ path: 'rewardId' })] });
    }
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-01', config: { stampThreshold: 3, rewardId } })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID' });
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-01', config: { ...base, rewardId } })).resolves.toMatchObject({ status: 'draft' });
  });

  it('adds one stamp per qualifying receipt with no points, and a receipt below the minimum earns nothing', async () => {
    const account = await member();
    const small = await buy(loyalty, account, 1.5, `s-${run}-small`);
    expect(small.account.points).toBe(0);
    expect(await progress(account)).toEqual({}); // an empty card: no stamp
    await buy(loyalty, account, 5, `s-${run}-1`);
    expect(await progress(account)).toMatchObject({ stamps: 1, cycle: 0 });
    const ledger = (await admin.query(`select points, program_id, notes from loyalty_transactions where loyalty_account_id=$1 order by created_at`, [account])).rows;
    expect(ledger).toEqual([
      { points: 0, program_id: programId, notes: 'Did not qualify (BELOW_MINIMUM).' },
      { points: 0, program_id: programId, notes: null },
    ]);
  });

  it('completing a card creates exactly one single-use entitlement and restarts the card', async () => {
    const account = await member();
    for (const i of [1, 2]) await buy(loyalty, account, 5, `c-${run}-${i}`);
    expect(await entitlements(account)).toEqual([]);
    const third = await buy(loyalty, account, 5, `c-${run}-3`);
    expect(third.account.points).toBe(0);
    expect(await entitlements(account)).toEqual([{ source_key: 'cycle:1', status: 'available', reward_id: rewardId }]);
    expect(await progress(account)).toMatchObject({ stamps: 0, cycle: 1, cycleStartedAt: null });
    for (const i of [4, 5, 6]) await buy(loyalty, account, 5, `c-${run}-${i}`);
    expect((await entitlements(account)).map((e) => e.source_key)).toEqual(['cycle:1', 'cycle:2']);
    const history = (await admin.query(`select kind, delta from loyalty_program_progress_events where loyalty_account_id=$1 order by created_at, id`, [account])).rows;
    expect(history.filter((h) => h.kind === 'stamp')).toHaveLength(6);
    expect(history.filter((h) => h.kind === 'cycle_completed')).toHaveLength(2);
  });

  it('a replayed receipt never adds a second stamp, and concurrent replays add exactly one', async () => {
    const account = await member();
    await buy(loyalty, account, 5, `r-${run}-1`);
    await buy(loyalty, account, 5, `r-${run}-1`);
    expect(await progress(account)).toMatchObject({ stamps: 1 });
    const outcomes = await race(6, (service) => buy(service, account, 7, `r-${run}-same`));
    expect(outcomes.filter((o) => o.inserted)).toHaveLength(1);
    expect(await progress(account)).toMatchObject({ stamps: 2 });
  });

  it('concurrent DIFFERENT receipts on one card are serialised: no lost stamp and no double reward', async () => {
    const account = await member();
    await race(7, (service, i) => buy(service, account, 5, `k-${run}-${i}`));
    // 7 stamps on a 3-stamp card = 2 completed cards + 1 stamp, regardless of ordering.
    expect(await progress(account)).toMatchObject({ stamps: 1, cycle: 2 });
    expect((await entitlements(account)).map((e) => e.source_key).sort()).toEqual(['cycle:1', 'cycle:2']);
  });

  it('an expired card is emptied before the new receipt counts', async () => {
    const account = await member();
    await buy(loyalty, account, 5, `e-${run}-1`);
    await buy(loyalty, account, 5, `e-${run}-2`);
    await admin.query(`update loyalty_program_progress set counters = jsonb_set(counters, '{cycleStartedAt}', to_jsonb((now() - interval '31 days')::text)) where program_id=$1 and loyalty_account_id=$2`, [programId, account]);
    await buy(loyalty, account, 5, `e-${run}-3`);
    expect(await progress(account)).toMatchObject({ stamps: 1, cycle: 0 });
    expect(await entitlements(account)).toEqual([]);
    const expired = (await admin.query(`select delta from loyalty_program_progress_events where loyalty_account_id=$1 and kind='expired'`, [account])).rows;
    expect(expired).toEqual([{ delta: -2 }]);
  });

  it('an entitlement is single-use, business-bound, and safe against a double redemption race', async () => {
    const account = await member();
    for (const i of [1, 2, 3]) await buy(loyalty, account, 5, `u-${run}-${i}`);
    const [entitlement] = (await admin.query(`select id from loyalty_program_entitlements where loyalty_account_id=$1`, [account])).rows;
    await expect(consumeEntitlement(buildDb(admin), { businessId: otherBusinessId, entitlementId: entitlement.id, redeemedBy: ownerId })).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_AVAILABLE' });
    const results = await Promise.allSettled([
      consumeEntitlement(buildDb(raceA), { businessId, entitlementId: entitlement.id, redeemedBy: ownerId }),
      consumeEntitlement(buildDb(raceB), { businessId, entitlementId: entitlement.id, redeemedBy: ownerId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(consumeEntitlement(buildDb(admin), { businessId, entitlementId: entitlement.id, redeemedBy: ownerId })).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_AVAILABLE' });
    // The database also refuses to reopen a used entitlement or delete it.
    await expect(admin.query(`update loyalty_program_entitlements set status='available' where id=$1`, [entitlement.id])).rejects.toThrow(/LOYALTY_ENTITLEMENT_FINAL/);
    await expect(admin.query(`delete from loyalty_program_entitlements where id=$1`, [entitlement.id])).rejects.toThrow(/LOYALTY_ENTITLEMENT_NOT_DELETABLE/);
  });

  it('LPC-05: a cashier lists and redeems an earned reward for the scanned account only, once, at an allowed branch', async () => {
    const db = buildDb(admin);
    const account = await member();
    const stranger = await member();
    for (const i of [1, 2, 3]) await buy(loyalty, account, 5, `lpc5-${run}-${i}`);
    const listed = await listAvailableEntitlements(db, { businessId, accountId: account, branchId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ rewardId, rewardName: 'Free coffee', rewardType: 'free_item' });
    expect(await listAvailableEntitlements(db, { businessId, accountId: stranger, branchId })).toEqual([]);
    // Another business cannot see or use this account's reward (uniform not-found / not-available).
    await expect(listAvailableEntitlements(db, { businessId: otherBusinessId, accountId: account })).rejects.toMatchObject({ code: 'LOYALTY_ACCOUNT_NOT_FOUND' });
    await expect(redeemAccountEntitlement(db, { businessId, accountId: stranger, entitlementId: listed[0]!.id, redeemedBy: ownerId, branchId })).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_AVAILABLE' });
    // A reward limited to a different branch cannot be handed over here.
    const otherBranch = (await repos.branches.create({ businessId, name: 'Other', slug: `lp01-b2-${run}` })).id;
    await admin.query(`update loyalty_rewards set branch_id=$1 where id=$2`, [otherBranch, rewardId]);
    try {
      expect(await listAvailableEntitlements(db, { businessId, accountId: account, branchId })).toEqual([]);
      await expect(redeemAccountEntitlement(db, { businessId, accountId: account, entitlementId: listed[0]!.id, redeemedBy: ownerId, branchId })).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_AVAILABLE' });
    } finally {
      await admin.query(`update loyalty_rewards set branch_id=null where id=$1`, [rewardId]);
    }
    // A suspended account is refused; an active one redeems exactly once.
    await admin.query(`update loyalty_accounts set status='suspended' where id=$1`, [account]);
    await expect(redeemAccountEntitlement(db, { businessId, accountId: account, entitlementId: listed[0]!.id, redeemedBy: ownerId, branchId })).rejects.toMatchObject({ code: 'LOYALTY_ACCOUNT_SUSPENDED' });
    await admin.query(`update loyalty_accounts set status='active' where id=$1`, [account]);
    await expect(redeemAccountEntitlement(db, { businessId, accountId: account, entitlementId: listed[0]!.id, redeemedBy: ownerId, branchId })).resolves.toMatchObject({ rewardId });
    await expect(redeemAccountEntitlement(db, { businessId, accountId: account, entitlementId: listed[0]!.id, redeemedBy: ownerId, branchId })).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_AVAILABLE' });
    expect(await listAvailableEntitlements(db, { businessId, accountId: account, branchId })).toEqual([]);
  });

  it('LPC-07: the customer sees their own stamps and waiting rewards, and nothing of anyone else', async () => {
    const db = buildDb(admin);
    const account = await member();
    const other = await member();
    const customerOf = async (accountId: string) => (await admin.query(`select customer_id from loyalty_accounts where id=$1`, [accountId])).rows[0].customer_id as string;
    for (const i of [1, 2]) await buy(loyalty, account, 5, `lpc7-${run}-${i}`);
    const card = await customerProgrammeCard(db, { customerId: await customerOf(account), businessId });
    expect(card.programme).toMatchObject({ type: 'LP-01', view: { kind: 'stamps', stamps: 2, threshold: 3, rewardId } });
    expect(card.programme!.rewardNames[rewardId]).toBe('Free coffee');
    expect(card.earnedRewards).toEqual([]);
    await buy(loyalty, account, 5, `lpc7-${run}-3`);
    const done = await customerProgrammeCard(db, { customerId: await customerOf(account), businessId });
    expect(done.programme!.view).toMatchObject({ stamps: 0, completedCards: 1 });
    expect(done.earnedRewards).toEqual([{ rewardName: 'Free coffee', expiresAt: null }]);
    expect(JSON.stringify(done)).not.toMatch(/loyaltyAccountId|customerId|"id"/);
    // Another customer has their own empty card; a non-member and another business's customer get a uniform not-found.
    const theirs = await customerProgrammeCard(db, { customerId: await customerOf(other), businessId });
    expect(theirs.programme!.view).toMatchObject({ stamps: 0, completedCards: 0 });
    expect(theirs.earnedRewards).toEqual([]);
    await expect(customerProgrammeCard(db, { customerId: await customerOf(account), businessId: otherBusinessId })).rejects.toMatchObject({ code: 'LOYALTY_ACCOUNT_NOT_FOUND' });
  });

  it('the database rejects an entitlement or progress row that crosses businesses', async () => {
    const foreignReward = (await admin.query(`select id from loyalty_rewards where business_id=$1 limit 1`, [otherBusinessId])).rows[0].id;
    const account = await member();
    await expect(
      admin.query(`insert into loyalty_program_entitlements (business_id, program_id, program_version, loyalty_account_id, reward_id, source_key) values ($1,$2,1,$3,$4,'x')`, [businessId, programId, account, foreignReward]),
    ).rejects.toThrow(/LOYALTY_PROGRAM_TENANT_MISMATCH/);
  });

  it('switching away freezes the card and keeps the stamps and entitlements', async () => {
    const account = await member();
    await buy(loyalty, account, 5, `f-${run}-1`);
    await buy(loyalty, account, 5, `f-${run}-2`);
    const next = await programmes.createDraft(businessId, ownerId, { type: 'LP-03', config: { pointsPerCurrencyUnit: '1', pointsPerCheckin: 0 } });
    await programmes.validate(businessId, ownerId, next.id);
    await programmes.activate(businessId, ownerId, next.id);
    const frozen = (await admin.query(`select counters, frozen_at from loyalty_program_progress where program_id=$1 and loyalty_account_id=$2`, [programId, account])).rows[0];
    expect(frozen.counters).toMatchObject({ stamps: 2 });
    expect(frozen.frozen_at).not.toBeNull();
    await expect(admin.query(`update loyalty_program_progress set counters='{"stamps":9}'::jsonb where program_id=$1 and loyalty_account_id=$2`, [programId, account])).rejects.toThrow(/LOYALTY_PROGRAM_PROGRESS_FROZEN/);
    // Stamps are NOT converted to points: the new programme starts the customer's points fresh from this purchase on.
    expect((await buy(loyalty, account, 5, `f-${run}-3`)).account.points).toBe(5);
    expect((await progress(account))).toMatchObject({ stamps: 2 });
  });
});
