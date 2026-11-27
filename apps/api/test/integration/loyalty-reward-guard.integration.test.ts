import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService } from '../../src/loyalty/programs/program.service';
import { assertRewardCanChange, findRewardUsage } from '../../src/loyalty/programs/reward-usage.service';
import { consumeEntitlement } from '../../src/loyalty/programs/stamp.service';
import { appDbOf } from '../helpers/runtime-db';

/** LPC-09: the reward catalogue cannot be changed from under the active programme or earned-but-unused rewards. */
describe.skipIf(!process.env.DATABASE_URL)('reward in-use guard (integration)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  let admin: Client;
  let ownerId: string;
  let businessId: string;
  let branchId: string;
  let rewardA: string;
  let rewardB: string;
  let accountId: string;
  let lp01: string;
  let programmes: LoyaltyProgramService;
  let loyalty: LoyaltyAccountService;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const db = buildDb(admin);
    const repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    loyalty = new LoyaltyAccountService(appDbOf(db));
    ownerId = (await repos.users.create({ email: `guard-${run}@example.test`, fullName: 'owner', passwordHash: 'x', status: 'active' })).id;
    businessId = (await new BusinessService(appDbOf(db)).createBusiness({ name: `Guard ${run}` } as never, ownerId)).businessId;
    branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `guard-${run}` })).id;
    rewardA = (await repos.loyaltyRewards.create({ businessId, name: 'In use', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    rewardB = (await repos.loyaltyRewards.create({ businessId, name: 'Unused', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const draft = await programmes.createDraft(businessId, ownerId, { type: 'LP-01', config: { stampThreshold: 2, rewardId: rewardA, stampExpiryDays: null, resetPolicy: 'on_completion' } });
    lp01 = draft.id;
    await programmes.validate(businessId, ownerId, lp01);
    await programmes.activate(businessId, ownerId, lp01);
    const customer = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: customer.id, businessId, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'guard' });
    accountId = (await repos.loyaltyAccounts.create({ customerId: customer.id, businessId, membershipId: membership.id })).id;
  });
  afterAll(async () => { await admin.end(); });

  const db = () => buildDb(admin);

  it('refuses to switch off or delete a reward the active programme pays out, and allows an unused one', async () => {
    expect(await findRewardUsage(db(), businessId, rewardA)).toMatchObject({ activeProgrammes: [{ id: lp01, type: 'LP-01' }], waitingEntitlements: 0 });
    await expect(assertRewardCanChange(db(), { businessId, rewardId: rewardA, change: 'deactivate' })).rejects.toMatchObject({ code: 'REWARD_IN_USE_BY_PROGRAMME', status: 409 });
    await expect(assertRewardCanChange(db(), { businessId, rewardId: rewardA, change: 'remove' })).rejects.toMatchObject({ code: 'REWARD_IN_USE_BY_PROGRAMME' });
    await expect(assertRewardCanChange(db(), { businessId, rewardId: rewardB, change: 'deactivate' })).resolves.toBeUndefined();
    await expect(assertRewardCanChange(db(), { businessId, rewardId: rewardB, change: 'remove' })).resolves.toBeUndefined();
  });

  it('another business is never told about, or blocked by, this business’s programme', async () => {
    const otherId = (await new BusinessService(appDbOf(db())).createBusiness({ name: `Guard other ${run}` } as never, ownerId)).businessId;
    expect(await findRewardUsage(db(), otherId, rewardA)).toEqual({ activeProgrammes: [], waitingEntitlements: 0 });
  });

  it('once the programme is switched away the reward can be switched off, but not deleted while customers still wait for it', async () => {
    for (const i of [1, 2]) await loyalty.recordPurchase({ businessId, branchId, accountId, purchaseAmount: 5, idempotencyKey: `g-${run}-${i}`, channel: 'branch', staffUserId: ownerId });
    expect((await findRewardUsage(db(), businessId, rewardA)).waitingEntitlements).toBe(1);
    const next = await programmes.createDraft(businessId, ownerId, { type: 'LP-03', config: { pointsPerCurrencyUnit: '1' } });
    await programmes.validate(businessId, ownerId, next.id);
    await programmes.activate(businessId, ownerId, next.id);
    expect((await findRewardUsage(db(), businessId, rewardA)).activeProgrammes).toEqual([]);
    await expect(assertRewardCanChange(db(), { businessId, rewardId: rewardA, change: 'deactivate' })).resolves.toBeUndefined();
    await expect(assertRewardCanChange(db(), { businessId, rewardId: rewardA, change: 'remove' })).rejects.toMatchObject({ code: 'REWARD_HAS_WAITING_ENTITLEMENTS' });
    const [entitlement] = (await admin.query(`select id from loyalty_program_entitlements where loyalty_account_id=$1`, [accountId])).rows;
    await consumeEntitlement(db(), { businessId, entitlementId: entitlement.id, redeemedBy: ownerId });
    await expect(assertRewardCanChange(db(), { businessId, rewardId: rewardA, change: 'remove' })).resolves.toBeUndefined();
  });
});
