import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyRedemptionService } from '../../src/loyalty/loyalty-redemption.service';

// createdBy/actor columns are `uuid` at the schema level -- a placeholder
// string like STAFF_ACTOR_ID fails at the database, not just in spirit; these
// tests don't assert on the actor's identity, only that one is recorded.
const STAFF_ACTOR_ID = crypto.randomUUID();

/**
 * LoyaltyRedemptionService, like LoyaltyAccountService, owns its own
 * transaction (deducting points + writing the ledger row atomically), so
 * this is integration-only, same reasoning as loyalty-points-engine's
 * suite. Also the only place that verifies the redemption_code unique
 * index (loyalty_transactions_redemption_code_key) actually exists at the
 * database level, not just in LoyaltyRedemptionService's own read-before-
 * insert collision check.
 */
describe.skipIf(!process.env.DATABASE_URL)('LoyaltyRedemptionService (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let accountService: LoyaltyAccountService;
  let redemptionService: LoyaltyRedemptionService;
  let businessA: string;
  let businessB: string;
  let customerId: string;
  let rewardId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = buildDb(client);
    repos = createRepositories(db);
    accountService = new LoyaltyAccountService(db);
    redemptionService = new LoyaltyRedemptionService(db);

    const bizA = await repos.businesses.create({
      name: 'Loyalty Redemption Test Business A',
      slug: `loyalty-redemption-a-${crypto.randomUUID()}`,
    });
    businessA = bizA.id;
    const bizB = await repos.businesses.create({
      name: 'Loyalty Redemption Test Business B',
      slug: `loyalty-redemption-b-${crypto.randomUUID()}`,
    });
    businessB = bizB.id;

    const customer = await repos.customers.create({ phone: `+1555${Date.now()}9` });
    customerId = customer.id;

    const account = await accountService.enroll({ customerId, businessId: businessA });
    await accountService.adjustPoints(businessA, account.id, 500, 'seed points for redemption test', STAFF_ACTOR_ID);

    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Free coffee',
      pointsCost: 100,
    });
    rewardId = reward.id;
  });

  afterAll(async () => {
    await repos.businesses.softDelete(businessA, businessA);
    await repos.businesses.softDelete(businessB, businessB);
    await client.end();
  });

  it('redeem deducts the reward\'s points cost and returns a unique redemption code', async () => {
    const before = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);
    const result = await redemptionService.redeem(customerId, businessA, rewardId);

    expect(result.pointsSpent).toBe(100);
    expect(result.remainingBalance).toBe(before!.points - 100);
    expect(result.redemptionCode).toHaveLength(8);
  });

  it('redeem rejects when the customer does not have enough points', async () => {
    const expensiveReward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Impossibly expensive reward',
      pointsCost: 1_000_000,
    });

    await expect(redemptionService.redeem(customerId, businessA, expensiveReward.id)).rejects.toMatchObject({
      code: 'INSUFFICIENT_POINTS',
      status: 422,
    });
  });

  it('redeem rejects a reward that has been deactivated', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Soon to be retired',
      pointsCost: 10,
    });
    await repos.loyaltyRewards.update(reward.id, businessA, { status: 'inactive' }, STAFF_ACTOR_ID);

    await expect(redemptionService.redeem(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_NOT_FOUND',
    });
  });

  it('redeem rejects a non-points-type reward (Block 6.2)', async () => {
    const discount = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: '10% off',
      type: 'discount',
      rewardValue: '10.00',
    });

    await expect(redemptionService.redeem(customerId, businessA, discount.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_WRONG_TYPE',
      status: 422,
    });
  });

  it('confirmRedemption marks a code confirmed exactly once, rejecting a second confirm attempt', async () => {
    const result = await redemptionService.redeem(customerId, businessA, rewardId);

    const confirmed = await redemptionService.confirmRedemption(businessA, result.redemptionCode);
    expect(confirmed.redemptionConfirmedAt).not.toBeNull();

    await expect(redemptionService.confirmRedemption(businessA, result.redemptionCode)).rejects.toMatchObject({
      code: 'REDEMPTION_ALREADY_CONFIRMED',
      status: 409,
    });
  });

  it('confirmRedemption 404s for a real code that belongs to a DIFFERENT business -- tenant isolation via the account join, not a businessId column on the ledger row', async () => {
    const result = await redemptionService.redeem(customerId, businessA, rewardId);

    await expect(redemptionService.confirmRedemption(businessB, result.redemptionCode)).rejects.toMatchObject({
      code: 'REDEMPTION_NOT_FOUND',
      status: 404,
    });
  });

  it('confirmRedemption 404s for a code that never existed', async () => {
    await expect(redemptionService.confirmRedemption(businessA, 'NOTAREAL')).rejects.toMatchObject({
      code: 'REDEMPTION_NOT_FOUND',
    });
  });

  // Continuing Development Block 6.2 (S6.2 reward types, S6.7 state
  // machine) -- issue() is the non-points counterpart to redeem() above.

  it('issue grants a non-points reward without touching the account\'s points balance (Block 6.2)', async () => {
    const voucher = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Free dessert',
      type: 'voucher',
      rewardValue: '5.00',
    });
    const before = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);

    const result = await redemptionService.issue(customerId, businessA, voucher.id);

    expect(result.redemptionCode).toHaveLength(8);
    expect(result.reward).toMatchObject({ id: voucher.id, name: 'Free dessert', type: 'voucher' });
    const after = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);
    expect(after!.points).toBe(before!.points); // no balance change -- this is the whole point of the guard below

    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(result.redemptionCode);
    expect(transaction).toMatchObject({ points: 0, issuanceStatus: 'issued', relatedRewardId: voucher.id });
  });

  it('issue rejects a points-type reward (Block 6.2)', async () => {
    await expect(redemptionService.issue(customerId, businessA, rewardId)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_WRONG_TYPE',
      status: 422,
    });
  });

  it('issue rejects a reward outside its active date window (Block 6.2)', async () => {
    const notYetStarted = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Future campaign',
      type: 'discount',
      rewardValue: '15.00',
      startDate: new Date(Date.now() + 86_400_000), // starts tomorrow
    });

    await expect(redemptionService.issue(customerId, businessA, notYetStarted.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_NOT_STARTED',
    });
  });

  it('confirmRedemption on an issued campaign-type code transitions issuanceStatus to redeemed, same call as the points path (Block 6.2)', async () => {
    const freeItem = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Free item',
      type: 'free_item',
    });
    const { redemptionCode } = await redemptionService.issue(customerId, businessA, freeItem.id);

    const confirmed = await redemptionService.confirmRedemption(businessA, redemptionCode);
    expect(confirmed.redemptionConfirmedAt).not.toBeNull();
    expect(confirmed.issuanceStatus).toBe('redeemed');

    // Same double-confirm guard as the points path -- one shared code path
    // (LoyaltyTransactionRepository.confirmRedemption), not a parallel one.
    await expect(redemptionService.confirmRedemption(businessA, redemptionCode)).rejects.toMatchObject({
      code: 'REDEMPTION_ALREADY_CONFIRMED',
      status: 409,
    });
  });
});
