import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyRedemptionService } from '../../src/loyalty/loyalty-redemption.service';
import { LoyaltyRewardService } from '../../src/loyalty/loyalty-reward.service';
import { generateRedemptionCode } from '../../src/loyalty/redemption-code';
import { VisitSessionService } from '../../src/visits/visit-session.service';

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
 *
 * Continuing Development Block 6.7.4 (S6.3 campaign dashboard tests) also
 * added LoyaltyTransactionRepository.getCampaignStats() and
 * LoyaltyRewardService.getCampaignDashboard() coverage at the bottom of
 * this file, rather than in loyalty-reward.integration.test.ts where
 * LoyaltyRewardService's other integration coverage lives -- proving those
 * two methods needs real redemption history (issue/redeem + confirmRedemption
 * against real rows), and this file already has that fixture stack built;
 * duplicating a second customer/account/redemption setup in the reward file
 * just to reach the same coverage would be the same logic twice.
 */
describe.skipIf(!process.env.DATABASE_URL)('LoyaltyRedemptionService (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let accountService: LoyaltyAccountService;
  let redemptionService: LoyaltyRedemptionService;
  // Block 6.7.4 (S6.3 campaign dashboard tests) -- constructed the same way
  // loyalty-reward.integration.test.ts does (repos, no db-only args), reused
  // by the getCampaignDashboard cases at the bottom of this file so they can
  // share this file's existing customer/account/points fixtures instead of
  // standing up a parallel set.
  let rewardService: LoyaltyRewardService;
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
    rewardService = new LoyaltyRewardService(repos);

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

  // Continuing Development Block 6.3 (S6.8 "eligible branch") --
  // reward.branchId scopes a reward to one specific branch; confirmRedemption
  // checks it against the CONFIRMING staff member's branch context, not
  // against redeem()/issue() (a customer redeeming from the app has no
  // branch to give). Every reward used in the tests above has
  // branchId === null (business-wide), so none of them exercise this path --
  // these three are the only ones that do.

  it('confirmRedemption rejects when the reward is branch-scoped and the confirming branch does not match (Block 6.3)', async () => {
    const branchA1 = await repos.branches.create({
      businessId: businessA,
      name: 'Branch A1',
      slug: `branch-a1-${crypto.randomUUID()}`,
    });
    const branchA2 = await repos.branches.create({
      businessId: businessA,
      name: 'Branch A2',
      slug: `branch-a2-${crypto.randomUUID()}`,
    });
    const branchReward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Branch A1 only',
      pointsCost: 5,
      branchId: branchA1.id,
    });
    const { redemptionCode } = await redemptionService.redeem(customerId, businessA, branchReward.id);

    await expect(redemptionService.confirmRedemption(businessA, redemptionCode, branchA2.id)).rejects.toMatchObject({
      code: 'LOYALTY_REDEMPTION_WRONG_BRANCH',
      status: 422,
    });
  });

  it('confirmRedemption rejects a branch-scoped reward when the confirming request has no branch context at all (Block 6.3)', async () => {
    const branchA3 = await repos.branches.create({
      businessId: businessA,
      name: 'Branch A3',
      slug: `branch-a3-${crypto.randomUUID()}`,
    });
    const branchReward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Branch A3 only',
      pointsCost: 5,
      branchId: branchA3.id,
    });
    const { redemptionCode } = await redemptionService.redeem(customerId, businessA, branchReward.id);

    // No third argument -- same as a business-wide staff session with no
    // X-Branch-Id header. Fails closed: a branch-scoped reward requires a
    // branch context to confirm, same reasoning as S2.16's fail-closed
    // instruction for reward eligibility generally.
    await expect(redemptionService.confirmRedemption(businessA, redemptionCode)).rejects.toMatchObject({
      code: 'LOYALTY_REDEMPTION_WRONG_BRANCH',
      status: 422,
    });
  });

  it("confirmRedemption succeeds when the confirming branch matches the reward's eligible branch (Block 6.3)", async () => {
    const branchA4 = await repos.branches.create({
      businessId: businessA,
      name: 'Branch A4',
      slug: `branch-a4-${crypto.randomUUID()}`,
    });
    const branchReward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Branch A4 only',
      pointsCost: 5,
      branchId: branchA4.id,
    });
    const { redemptionCode } = await redemptionService.redeem(customerId, businessA, branchReward.id);

    const confirmed = await redemptionService.confirmRedemption(businessA, redemptionCode, branchA4.id);
    expect(confirmed.redemptionConfirmedAt).not.toBeNull();
  });

  // Continuing Development Block 6.4 (S5.8 "maximum rewards per day" +
  // S6.1 "maximum reward budget") -- checkDailyAndBudgetLimits(), shared by
  // issue() and redeem(). maxBudget is a deliberate no-op for a
  // 'points'-type reward (confirmed with the project owner): rewardValue is
  // always null there, so the budget arm of the check never fires.

  it('issue rejects once maxRewardsPerDay is reached for that reward (Block 6.4)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'One a day',
      type: 'voucher',
      rewardValue: '5.00',
      maxRewardsPerDay: 1,
    });

    await redemptionService.issue(customerId, businessA, reward.id);

    await expect(redemptionService.issue(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_DAILY_LIMIT_REACHED',
      status: 422,
    });
  });

  it('issue allows redemptions up to maxBudget and rejects the one that would exceed it (Block 6.4)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Budget-capped voucher',
      type: 'voucher',
      rewardValue: '10.00',
      maxBudget: '20.00', // exactly 2 issuances' worth
    });

    await redemptionService.issue(customerId, businessA, reward.id);
    await redemptionService.issue(customerId, businessA, reward.id);

    await expect(redemptionService.issue(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_BUDGET_EXCEEDED',
      status: 422,
    });
  });

  it('redeem still enforces maxRewardsPerDay for a points-type reward (Block 6.4)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Points reward, one a day',
      pointsCost: 5,
      maxRewardsPerDay: 1,
    });

    await redemptionService.redeem(customerId, businessA, reward.id);

    await expect(redemptionService.redeem(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_DAILY_LIMIT_REACHED',
      status: 422,
    });
  });

  it('redeem does not enforce maxBudget for a points-type reward, even when maxBudget is set (Block 6.4)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Points reward with an inapplicable budget cap',
      pointsCost: 5,
      maxBudget: '0.01', // would reject immediately if budget applied to points -- it does not
    });

    const result = await redemptionService.redeem(customerId, businessA, reward.id);
    expect(result.redemptionCode).toHaveLength(8);
  });

  // Continuing Development Block 6.5 (S5.5 "customer cooldown" + S6.1
  // "one reward per ... defined period," the limitPer='period' case) --
  // checkCooldownAndPeriodLimit(), shared by issue() and redeem(). Both
  // rules reduce to "time since this customer's own last claim of this
  // reward," so several of these tests seed that history directly via
  // repos.loyaltyTransactions.create({..., createdAt: <backdated>}) rather
  // than waiting in real time -- the same reasoning this file already
  // relies on for direct-repository fixture setup throughout.

  it('issue rejects a second claim within cooldownSeconds for the same customer (Block 6.5)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'One-hour cooldown voucher',
      type: 'voucher',
      rewardValue: '5.00',
      cooldownSeconds: 3600,
    });

    await redemptionService.issue(customerId, businessA, reward.id);

    await expect(redemptionService.issue(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_COOLDOWN_ACTIVE',
      status: 422,
    });
  });

  it('issue allows a claim once cooldownSeconds has already elapsed (Block 6.5)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'One-minute cooldown voucher',
      type: 'voucher',
      rewardValue: '5.00',
      cooldownSeconds: 60,
    });
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);
    // Backdated well past the 60-second cooldown -- simulates "already
    // claimed a while ago" without a real wait.
    await repos.loyaltyTransactions.create({
      loyaltyAccountId: account!.id,
      type: 'redemption',
      points: 0,
      relatedRewardId: reward.id,
      redemptionCode: generateRedemptionCode(),
      issuanceStatus: 'issued',
      createdAt: new Date(Date.now() - 65_000),
    });

    const result = await redemptionService.issue(customerId, businessA, reward.id);
    expect(result.redemptionCode).toHaveLength(8);
  });

  it("issue does not apply one customer's cooldown to a different customer claiming the same reward (Block 6.5)", async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Shared cooldown voucher',
      type: 'voucher',
      rewardValue: '5.00',
      cooldownSeconds: 3600,
    });
    const otherCustomer = await repos.customers.create({ phone: `+1555${Date.now()}1` });
    await accountService.enroll({ customerId: otherCustomer.id, businessId: businessA });

    await redemptionService.issue(customerId, businessA, reward.id);

    // Same reward, different customer, immediately after -- this is the
    // case that would catch a wrong implementation scoped to rewardId
    // alone (campaign-wide, like checkDailyAndBudgetLimits) instead of
    // (rewardId, loyaltyAccountId).
    const result = await redemptionService.issue(otherCustomer.id, businessA, reward.id);
    expect(result.redemptionCode).toHaveLength(8);
  });

  it('issue rejects a second claim within limitPeriodDays when limitPer is \'period\' (Block 6.5)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Monthly voucher',
      type: 'voucher',
      rewardValue: '5.00',
      limitPer: 'period',
      limitPeriodDays: 30,
    });
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);
    await repos.loyaltyTransactions.create({
      loyaltyAccountId: account!.id,
      type: 'redemption',
      points: 0,
      relatedRewardId: reward.id,
      redemptionCode: generateRedemptionCode(),
      issuanceStatus: 'issued',
      createdAt: new Date(Date.now() - 5 * 86_400_000), // 5 days ago
    });

    await expect(redemptionService.issue(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_PERIOD_LIMIT_REACHED',
      status: 422,
    });
  });

  it('issue allows a claim once limitPeriodDays has already elapsed (Block 6.5)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Monthly voucher, elapsed',
      type: 'voucher',
      rewardValue: '5.00',
      limitPer: 'period',
      limitPeriodDays: 30,
    });
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);
    await repos.loyaltyTransactions.create({
      loyaltyAccountId: account!.id,
      type: 'redemption',
      points: 0,
      relatedRewardId: reward.id,
      redemptionCode: generateRedemptionCode(),
      issuanceStatus: 'issued',
      createdAt: new Date(Date.now() - 31 * 86_400_000), // 31 days ago
    });

    const result = await redemptionService.issue(customerId, businessA, reward.id);
    expect(result.redemptionCode).toHaveLength(8);
  });

  it('redeem also enforces cooldownSeconds for a points-type reward -- no type-based exception, unlike maxBudget (Block 6.5)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Points reward with a cooldown',
      pointsCost: 5,
      cooldownSeconds: 3600,
    });

    await redemptionService.redeem(customerId, businessA, reward.id);

    await expect(redemptionService.redeem(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_COOLDOWN_ACTIVE',
      status: 422,
    });
  });

  // Continuing Development Block 5 of the S6.4 roadmap (test coverage for
  // Blocks 2-4) -- Block 2 group first: resolveRedemptionReferences(),
  // shared by issue()/redeem(). Block 2 itself never blocks a redemption;
  // these prove the two reference fields resolve onto the created
  // transaction row correctly (or silently no-op) rather than proving any
  // enforcement -- see the Block 3 group below for the actual gating
  // tests. issue() (non-points) is used throughout, same reasoning as the
  // Block 6.7.4 group below: these don't compete with every other test in
  // this file for the shared customerId account's points balance.

  it('issue resolves a valid feedbackId onto the created transaction row (Block 2)', async () => {
    const branch = await repos.branches.create({
      businessId: businessA,
      name: 'Block 2 feedback branch',
      slug: `block-2-feedback-${crypto.randomUUID()}`,
    });
    const qrCode = await repos.qrCodes.create({ businessId: businessA, branchId: branch.id });
    const fb = await repos.feedback.create({
      businessId: businessA,
      branchId: branch.id,
      qrCodeId: qrCode.id,
      rating: 5,
      comment: 'Great service, very fast!',
    });
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 2 feedback-ref voucher',
      type: 'voucher',
      rewardValue: '5.00',
    });

    const { redemptionCode } = await redemptionService.issue(customerId, businessA, reward.id, {
      feedbackId: fb.id,
    });

    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(redemptionCode);
    expect(transaction!.feedbackId).toBe(fb.id);
  });

  it('issue silently drops an unresolvable feedbackId rather than blocking the redemption (Block 2)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 2 bad feedback-ref voucher',
      type: 'voucher',
      rewardValue: '5.00',
    });

    // A random UUID stands in for both "doesn't exist" and "wrong
    // business" -- resolveRedemptionReferences' existence + tenant-scope
    // check (FeedbackRepository.findById) collapses both to the identical
    // "unresolved" outcome, so one case proves both rather than
    // duplicating this test for a second tenant.
    const { redemptionCode } = await redemptionService.issue(customerId, businessA, reward.id, {
      feedbackId: crypto.randomUUID(),
    });

    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(redemptionCode);
    expect(transaction!.feedbackId).toBeNull();
  });

  it('issue resolves a valid visitProof+branchId to a real visitSessionId on the created row (Block 2)', async () => {
    const branch = await repos.branches.create({
      businessId: businessA,
      name: 'Block 2 visit branch',
      slug: `block-2-visit-${crypto.randomUUID()}`,
    });
    const session = await new VisitSessionService(repos).issue(businessA, branch.id, STAFF_ACTOR_ID, {
      ttlSeconds: 3600,
      maxUses: 1,
    });
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 2 visit-ref voucher',
      type: 'voucher',
      rewardValue: '5.00',
    });

    const { redemptionCode } = await redemptionService.issue(customerId, businessA, reward.id, {
      visitProof: session.code,
      branchId: branch.id,
    });

    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(redemptionCode);
    expect(transaction!.visitSessionId).toBe(session.id);
  });

  it('issue does not block on an invalid visitProof -- advisory only, logs a fraud signal instead (Block 2)', async () => {
    const branch = await repos.branches.create({
      businessId: businessA,
      name: 'Block 2 invalid-visit branch',
      slug: `block-2-invalid-visit-${crypto.randomUUID()}`,
    });
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 2 invalid-visit voucher',
      type: 'voucher',
      rewardValue: '5.00',
    });

    const { redemptionCode } = await redemptionService.issue(customerId, businessA, reward.id, {
      visitProof: 'NOT-A-REAL-CODE',
      branchId: branch.id,
    });

    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(redemptionCode);
    expect(transaction!.visitSessionId).toBeNull();

    const signals = await repos.fraudSignals.listOpenForBusiness(businessA, { branchId: branch.id });
    expect(signals).toContainEqual(expect.objectContaining({ signalType: 'visit_verification', feedbackId: null }));
  });

  it('issue leaves visitSessionId null when visitProof is supplied with no branchId -- branchId is required to even attempt verification (Block 2)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 2 no-branch voucher',
      type: 'voucher',
      rewardValue: '5.00',
    });

    // The .refine() that rejects this combination at the API boundary
    // lives on redeemRewardSchema/issueRewardSchema (the Zod layer), not
    // inside LoyaltyRedemptionService -- this test calls the service
    // directly, so it proves the service's own defense-in-depth behavior
    // (silently skip verification, same as omitting both fields) rather
    // than route-level validation, matching how this whole file exercises
    // the service layer, not the HTTP layer.
    const { redemptionCode } = await redemptionService.issue(customerId, businessA, reward.id, {
      visitProof: 'SOME-CODE',
    });

    const transaction = await repos.loyaltyTransactions.findByRedemptionCode(redemptionCode);
    expect(transaction!.visitSessionId).toBeNull();
  });

  it(
    'a redemption can record the SAME visitSessionId a checkin already used -- ' +
      "the Block 2 unique-index fix (loyalty_transactions_checkin_visit_key narrowed to type='checkin')",
    async () => {
      const branch = await repos.branches.create({
        businessId: businessA,
        name: 'Block 2 index-fix branch',
        slug: `block-2-index-fix-${crypto.randomUUID()}`,
      });
      // maxUses: null -- a shared table session, claimed twice below
      // (checkin + redemption), same as the checkin-dedup fixtures in
      // loyalty-points-engine.integration.test.ts.
      const session = await new VisitSessionService(repos).issue(businessA, branch.id, STAFF_ACTOR_ID, {
        ttlSeconds: 3600,
        maxUses: null,
      });
      const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);
      // Seed the checkin row directly -- QR checkin itself is
      // LoyaltyAccountService's own concern (loyalty-points-engine's test
      // suite), not this file's; only the shared unique index matters here.
      await repos.loyaltyTransactions.create({
        loyaltyAccountId: account!.id,
        type: 'checkin',
        points: 10,
        visitSessionId: session.id,
      });
      const reward = await repos.loyaltyRewards.create({
        businessId: businessA,
        name: 'Block 2 index-fix voucher',
        type: 'voucher',
        rewardValue: '5.00',
      });

      // Before the Block 2 fix, this insert would have hit
      // loyalty_transactions_checkin_visit_key (then unscoped by type) and
      // failed with a raw unique-constraint violation -- this call
      // succeeding at all is the real proof the narrowed index works, not
      // just the returned visitSessionId value below.
      const { redemptionCode } = await redemptionService.issue(customerId, businessA, reward.id, {
        visitProof: session.code,
        branchId: branch.id,
      });

      const transaction = await repos.loyaltyTransactions.findByRedemptionCode(redemptionCode);
      expect(transaction!.visitSessionId).toBe(session.id);
    },
  );

  // Continuing Development Block 5 of the S6.4 roadmap, Block 3 group:
  // checkMinimumFeedbackRequirements() and checkVisitLimit(), both called
  // from issue()/redeem() right after resolveRedemptionReferences()
  // resolves their input. issue() proves the gate logic itself; one
  // additional redeem() case at the end confirms the same checks are
  // wired into that method too, matching the "prove the shared logic once
  // via issue(), spot-check redeem() separately" precedent the Block 6.4
  // and Block 6.5 groups above already established for this file.

  it('issue rejects a redemption whose linked feedback comment is shorter than minCommentLength (Block 3)', async () => {
    const branch = await repos.branches.create({
      businessId: businessA,
      name: 'Block 3 short-comment branch',
      slug: `block-3-short-${crypto.randomUUID()}`,
    });
    const qrCode = await repos.qrCodes.create({ businessId: businessA, branchId: branch.id });
    const fb = await repos.feedback.create({
      businessId: businessA,
      branchId: branch.id,
      qrCodeId: qrCode.id,
      rating: 5,
      comment: 'Good',
    });
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 3 comment-gated voucher',
      type: 'voucher',
      rewardValue: '5.00',
      minCommentLength: 20,
    });

    await expect(
      redemptionService.issue(customerId, businessA, reward.id, { feedbackId: fb.id }),
    ).rejects.toMatchObject({ code: 'LOYALTY_REWARD_COMMENT_TOO_SHORT', status: 422 });
  });

  it('issue allows a redemption whose linked feedback comment meets minCommentLength (Block 3)', async () => {
    const branch = await repos.branches.create({
      businessId: businessA,
      name: 'Block 3 long-comment branch',
      slug: `block-3-long-${crypto.randomUUID()}`,
    });
    const qrCode = await repos.qrCodes.create({ businessId: businessA, branchId: branch.id });
    const fb = await repos.feedback.create({
      businessId: businessA,
      branchId: branch.id,
      qrCodeId: qrCode.id,
      rating: 5,
      comment: 'This place has genuinely great coffee and even better service.',
    });
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 3 comment-gated voucher, satisfied',
      type: 'voucher',
      rewardValue: '5.00',
      minCommentLength: 20,
    });

    const result = await redemptionService.issue(customerId, businessA, reward.id, { feedbackId: fb.id });
    expect(result.redemptionCode).toHaveLength(8);
  });

  it('issue rejects when minCommentLength is configured but no feedbackId was resolved at all (Block 3)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 3 comment-required, no feedback',
      type: 'voucher',
      rewardValue: '5.00',
      minCommentLength: 1,
    });

    await expect(redemptionService.issue(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_COMMENT_TOO_SHORT',
      status: 422,
    });
  });

  it('issue rejects when requireVisitVerification is set and no verified visit is attached (Block 3)', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 3 visit-required voucher',
      type: 'voucher',
      rewardValue: '5.00',
      requireVisitVerification: true,
    });

    await expect(redemptionService.issue(customerId, businessA, reward.id)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_VISIT_REQUIRED',
      status: 422,
    });
  });

  it('issue allows a requireVisitVerification reward when a real verified visit is attached (Block 3)', async () => {
    const branch = await repos.branches.create({
      businessId: businessA,
      name: 'Block 3 visit-verified branch',
      slug: `block-3-visit-verified-${crypto.randomUUID()}`,
    });
    const session = await new VisitSessionService(repos).issue(businessA, branch.id, STAFF_ACTOR_ID, {
      ttlSeconds: 3600,
      maxUses: 1,
    });
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Block 3 visit-required voucher, satisfied',
      type: 'voucher',
      rewardValue: '5.00',
      requireVisitVerification: true,
    });

    const result = await redemptionService.issue(customerId, businessA, reward.id, {
      visitProof: session.code,
      branchId: branch.id,
    });
    expect(result.redemptionCode).toHaveLength(8);
  });

  it(
    "issue rejects a limitPer='visit' reward when no verified visit is attached -- " +
      'fails closed, same code as requireVisitVerification (Block 3)',
    async () => {
      const reward = await repos.loyaltyRewards.create({
        businessId: businessA,
        name: 'Block 3 visit-limited voucher',
        type: 'voucher',
        rewardValue: '5.00',
        limitPer: 'visit',
      });

      await expect(redemptionService.issue(customerId, businessA, reward.id)).rejects.toMatchObject({
        code: 'LOYALTY_REWARD_VISIT_REQUIRED',
        status: 422,
      });
    },
  );

  it(
    "issue rejects a second claim of the SAME limitPer='visit' reward on the SAME visit " +
      'session by the SAME account (Block 3)',
    async () => {
      const branch = await repos.branches.create({
        businessId: businessA,
        name: 'Block 3 visit-dedup branch',
        slug: `block-3-visit-dedup-${crypto.randomUUID()}`,
      });
      // maxUses: null -- both claims below must successfully VERIFY the
      // same proof; the rejection under test has to come from
      // checkVisitLimit()'s own existence check, not from the visit
      // session itself running out of uses.
      const session = await new VisitSessionService(repos).issue(businessA, branch.id, STAFF_ACTOR_ID, {
        ttlSeconds: 3600,
        maxUses: null,
      });
      const reward = await repos.loyaltyRewards.create({
        businessId: businessA,
        name: 'Block 3 visit-limited voucher, dedup',
        type: 'voucher',
        rewardValue: '5.00',
        limitPer: 'visit',
      });

      await redemptionService.issue(customerId, businessA, reward.id, {
        visitProof: session.code,
        branchId: branch.id,
      });

      await expect(
        redemptionService.issue(customerId, businessA, reward.id, {
          visitProof: session.code,
          branchId: branch.id,
        }),
      ).rejects.toMatchObject({ code: 'LOYALTY_REWARD_VISIT_LIMIT_REACHED', status: 422 });
    },
  );

  it(
    "issue allows a DIFFERENT limitPer='visit' reward to be claimed on the same visit session -- " +
      'scoped by (rewardId, account, session), not session alone (Block 3)',
    async () => {
      const branch = await repos.branches.create({
        businessId: businessA,
        name: 'Block 3 visit-dedup-scope branch',
        slug: `block-3-visit-dedup-scope-${crypto.randomUUID()}`,
      });
      const session = await new VisitSessionService(repos).issue(businessA, branch.id, STAFF_ACTOR_ID, {
        ttlSeconds: 3600,
        maxUses: null,
      });
      const rewardX = await repos.loyaltyRewards.create({
        businessId: businessA,
        name: 'Block 3 visit-limited voucher X',
        type: 'voucher',
        rewardValue: '5.00',
        limitPer: 'visit',
      });
      const rewardY = await repos.loyaltyRewards.create({
        businessId: businessA,
        name: 'Block 3 visit-limited voucher Y',
        type: 'voucher',
        rewardValue: '5.00',
        limitPer: 'visit',
      });

      await redemptionService.issue(customerId, businessA, rewardX.id, {
        visitProof: session.code,
        branchId: branch.id,
      });

      // This is the case that would catch a wrong implementation scoped to
      // (loyaltyAccountId, visitSessionId) alone, without rewardId.
      const result = await redemptionService.issue(customerId, businessA, rewardY.id, {
        visitProof: session.code,
        branchId: branch.id,
      });
      expect(result.redemptionCode).toHaveLength(8);
    },
  );

  it(
    "issue allows a DIFFERENT account to claim the same limitPer='visit' reward on a shared " +
      'table-session code (Block 3)',
    async () => {
      const branch = await repos.branches.create({
        businessId: businessA,
        name: 'Block 3 visit-dedup-shared branch',
        slug: `block-3-visit-dedup-shared-${crypto.randomUUID()}`,
      });
      const session = await new VisitSessionService(repos).issue(businessA, branch.id, STAFF_ACTOR_ID, {
        ttlSeconds: 3600,
        maxUses: null,
      });
      const reward = await repos.loyaltyRewards.create({
        businessId: businessA,
        name: 'Block 3 visit-limited voucher, shared session',
        type: 'voucher',
        rewardValue: '5.00',
        limitPer: 'visit',
      });
      const otherCustomer = await repos.customers.create({ phone: `+1555${Date.now()}2` });
      await accountService.enroll({ customerId: otherCustomer.id, businessId: businessA });

      await redemptionService.issue(customerId, businessA, reward.id, {
        visitProof: session.code,
        branchId: branch.id,
      });

      // Same reward, same shared session code, DIFFERENT customer -- this
      // is the case that would catch a wrong implementation scoped to
      // (rewardId, visitSessionId) alone, without loyaltyAccountId,
      // matching the same cross-customer-isolation reasoning the Block 6.5
      // group above already established for this file's cooldown tests.
      const result = await redemptionService.issue(otherCustomer.id, businessA, reward.id, {
        visitProof: session.code,
        branchId: branch.id,
      });
      expect(result.redemptionCode).toHaveLength(8);
    },
  );

  it(
    'redeem also enforces requireVisitVerification for a points-type reward -- ' +
      'confirms the same shared checks issue() uses are wired into redeem() too (Block 3)',
    async () => {
      const reward = await repos.loyaltyRewards.create({
        businessId: businessA,
        name: 'Block 3 visit-required points reward',
        pointsCost: 5,
        requireVisitVerification: true,
      });

      await expect(redemptionService.redeem(customerId, businessA, reward.id)).rejects.toMatchObject({
        code: 'LOYALTY_REWARD_VISIT_REQUIRED',
        status: 422,
      });
    },
  );

  // Continuing Development Block 6.7.4 (S6.3 campaign dashboard tests).
  // getCampaignStats() (LoyaltyTransactionRepository, Block 6.7.1) and
  // getCampaignDashboard() (LoyaltyRewardService, Block 6.7.1 +
  // 6.7.3's branchName amendment) against real Postgres. The fake-repository
  // coverage in loyalty-reward.service.test.ts already proves the service's
  // own budget math and null-handling against a canned stats object; what
  // only a real database can prove -- the reason this half lives here, not
  // there -- is that getCampaignStats()'s FILTER-clause SQL actually counts
  // confirmed vs. unconfirmed redemptions correctly against real rows, and
  // that a real branches.name column round-trips through
  // getCampaignDashboard() end-to-end. Uses issue() (non-points) wherever a
  // test doesn't specifically need a points-type reward, so these don't
  // compete with every other test in this file for the shared customerId
  // account's points balance.

  it('getCampaignStats splits real redemption rows into outstanding vs. redeemed', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Stats test voucher',
      type: 'voucher',
      rewardValue: '5.00',
    });

    // Three separate customers, not the shared customerId -- avoids Block
    // 6.5's per-customer cooldown/period-limit rules (this reward sets
    // neither, but a distinct customer per claim is one less thing to
    // reason about) rejecting the 2nd/3rd claim.
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const customer = await repos.customers.create({ phone: `+1555${Date.now()}${i}` });
      await accountService.enroll({ customerId: customer.id, businessId: businessA });
      const { redemptionCode } = await redemptionService.issue(customer.id, businessA, reward.id);
      codes.push(redemptionCode);
    }
    // Confirm two of the three; leave the third outstanding.
    await redemptionService.confirmRedemption(businessA, codes[0]!);
    await redemptionService.confirmRedemption(businessA, codes[1]!);

    const stats = await repos.loyaltyTransactions.getCampaignStats(reward.id);
    expect(stats).toEqual({ totalCount: 3, redeemedCount: 2, outstandingCount: 1 });
  });

  it("getCampaignStats never counts a different reward's redemptions", async () => {
    const rewardX = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Stats isolation A',
      type: 'voucher',
      rewardValue: '5.00',
    });
    const rewardY = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Stats isolation B',
      type: 'voucher',
      rewardValue: '5.00',
    });
    const customer = await repos.customers.create({ phone: `+1555${Date.now()}9` });
    await accountService.enroll({ customerId: customer.id, businessId: businessA });
    await redemptionService.issue(customer.id, businessA, rewardX.id);

    const statsY = await repos.loyaltyTransactions.getCampaignStats(rewardY.id);
    expect(statsY).toEqual({ totalCount: 0, redeemedCount: 0, outstandingCount: 0 });
  });

  it('getCampaignDashboard computes real budget math end-to-end for a discount-type reward', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Dashboard budget test',
      type: 'discount',
      rewardValue: '9.10',
      maxBudget: '100.00',
    });
    const customer = await repos.customers.create({ phone: `+1555${Date.now()}8` });
    await accountService.enroll({ customerId: customer.id, businessId: businessA });
    const { redemptionCode } = await redemptionService.issue(customer.id, businessA, reward.id);
    await redemptionService.confirmRedemption(businessA, redemptionCode);

    const dashboard = await rewardService.getCampaignDashboard(reward.id, businessA);

    expect(dashboard.stats).toMatchObject({
      totalCount: 1,
      redeemedCount: 1,
      outstandingCount: 0,
      budgetTotal: 100,
      budgetUsed: 9.1,
      budgetRemaining: 90.9,
      outstandingLiability: 0,
    });
  });

  it('getCampaignDashboard reports null budget fields for a points-type reward, even with real redemption history', async () => {
    const reward = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Dashboard points test',
      pointsCost: 2,
    });
    // Explicit top-up rather than relying on whatever balance earlier tests
    // in this file happened to leave behind -- keeps this test correct
    // regardless of what runs before it.
    const account = await repos.loyaltyAccounts.findByCustomerAndBusiness(customerId, businessA);
    await accountService.adjustPoints(
      businessA,
      account!.id,
      100,
      'top up for campaign dashboard test',
      STAFF_ACTOR_ID,
    );
    await redemptionService.redeem(customerId, businessA, reward.id);

    const dashboard = await rewardService.getCampaignDashboard(reward.id, businessA);

    expect(dashboard.stats.totalCount).toBe(1);
    expect(dashboard.stats.budgetTotal).toBeNull();
    expect(dashboard.stats.budgetUsed).toBeNull();
    expect(dashboard.stats.budgetRemaining).toBeNull();
    expect(dashboard.stats.outstandingLiability).toBeNull();
  });

  it('getCampaignDashboard resolves a real branch name for a branch-scoped reward, and null for a business-wide one', async () => {
    const branch = await repos.branches.create({
      businessId: businessA,
      name: 'Dashboard Test Branch',
      slug: `dashboard-test-branch-${crypto.randomUUID()}`,
    });
    const scoped = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Branch-scoped dashboard reward',
      pointsCost: 5,
      branchId: branch.id,
    });
    const businessWide = await repos.loyaltyRewards.create({
      businessId: businessA,
      name: 'Business-wide dashboard reward',
      pointsCost: 5,
    });

    const scopedDashboard = await rewardService.getCampaignDashboard(scoped.id, businessA);
    const wideDashboard = await rewardService.getCampaignDashboard(businessWide.id, businessA);

    expect(scopedDashboard.branchName).toBe('Dashboard Test Branch');
    expect(wideDashboard.branchName).toBeNull();
  });

  it('getCampaignDashboard 404s for a reward that does not exist', async () => {
    await expect(rewardService.getCampaignDashboard(crypto.randomUUID(), businessA)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_NOT_FOUND',
      status: 404,
    });
  });
});
