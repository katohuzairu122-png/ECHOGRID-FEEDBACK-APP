import { describe, it, expect, beforeEach } from 'vitest';
import { LoyaltyRewardService } from './loyalty-reward.service';
import type { LoyaltyReward, NewLoyaltyReward } from '../repositories/loyalty-reward.repository';

function createFakeRewardRepo() {
  const rewards = new Map<string, LoyaltyReward>();

  return {
    async findById(id: string, businessId: string) {
      const reward = rewards.get(id);
      return reward && reward.businessId === businessId && !reward.isDeleted ? reward : undefined;
    },
    async listForBusiness(businessId: string, options: { includeInactive?: boolean } = {}) {
      return [...rewards.values()]
        .filter(
          (r) =>
            r.businessId === businessId &&
            !r.isDeleted &&
            (options.includeInactive || r.status === 'active'),
        )
        .sort((a, b) => (a.pointsCost ?? 0) - (b.pointsCost ?? 0)); // Block 6.2: pointsCost is nullable now (non-points types)
    },
    async create(input: NewLoyaltyReward): Promise<LoyaltyReward> {
      const reward: LoyaltyReward = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        // Block 6.1 (S6.1) fields -- same input.X ?? default pattern as
        // every other nullable/defaulted field in this fake, mirroring the
        // real schema's own defaults (loyalty-rewards.ts).
        branchId: input.branchId ?? null,
        type: input.type ?? 'points',
        rewardValue: input.rewardValue ?? null,
        startDate: input.startDate ?? null,
        expiryDate: input.expiryDate ?? null,
        maxRewardsPerDay: input.maxRewardsPerDay ?? null,
        maxBudget: input.maxBudget ?? null,
        limitPer: input.limitPer ?? null,
        limitPeriodDays: input.limitPeriodDays ?? null,
        cooldownSeconds: input.cooldownSeconds ?? null,
        // Block 6.9 (S6.4) fields -- same input.X ?? default pattern as the
        // Block 6.1 group above. Missing this literal is exactly the bug
        // class documented in the "Block 6.1 CI-failure note": a hand-typed
        // `LoyaltyReward` object literal must carry every column the real
        // schema (`$inferSelect`) now has, even a nullable one, with an
        // explicit `null` rather than an omitted key.
        minCommentLength: input.minCommentLength ?? null,
        requireVisitVerification: input.requireVisitVerification ?? false,
        name: input.name,
        description: input.description ?? null,
        pointsCost: input.pointsCost ?? null, // Block 6.2: nullable now (non-points types)
        status: input.status ?? 'active',
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
        updatedAt: new Date(),
        updatedBy: input.updatedBy ?? null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
      };
      rewards.set(reward.id, reward);
      return reward;
    },
    async update(id: string, businessId: string, patch: Partial<NewLoyaltyReward>, updatedBy: string) {
      const reward = rewards.get(id);
      if (!reward || reward.businessId !== businessId) return undefined;
      // Block 6.6 (S6.1) fix: only assign keys whose value is actually
      // defined, mirroring the real repository's Drizzle-backed `.set()`
      // behavior -- an explicit `undefined` in a patch object skips that
      // column rather than writing NULL over it (see convertCampaignFields'
      // comment in loyalty-reward.service.ts, and Patch<T> in lib/types.ts).
      // Plain Object.assign does NOT have that behavior: it copies an
      // `undefined` value like any other property, which would silently
      // wipe every field LoyaltyRewardService.update() didn't ask to change
      // -- it always sends all 14 patchable keys, `undefined` for the ones
      // the caller omitted, never fewer keys. This was a latent bug in the
      // fake only (the real Drizzle repository was never affected -- that
      // "skip undefined" behavior is confirmed elsewhere in this codebase
      // already); no test before this block happened to assert on a field
      // it hadn't just set, so nothing caught it until now.
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (reward as Record<string, unknown>)[key] = value;
      }
      reward.updatedBy = updatedBy;
      reward.updatedAt = new Date();
      return reward;
    },
    async softDelete(id: string, businessId: string, deletedBy: string) {
      const reward = rewards.get(id);
      if (reward && reward.businessId === businessId) {
        reward.isDeleted = true;
        reward.deletedAt = new Date();
        reward.deletedBy = deletedBy;
      }
    },
  };
}

/** Block 6.6 (S6.1) addition -- LoyaltyRewardService now depends on
 * `repos.branches` too (branch-scoping validation), so the fake needs one.
 * `seed()` is test-only surface, not part of the real BranchRepository
 * shape: it registers a branch id as belonging to a business so a test can
 * exercise the "belongs to this business" success path without a full fake
 * branch object. An empty repo (no seed() calls) makes every findById()
 * miss, which is the right default for tests that never set branchId --
 * assertBranchBelongsToBusiness short-circuits before ever calling
 * findById in that case. */
function createFakeBranchRepo() {
  // branchId -> {businessId, name}. `name` is Block 6.7.4's addition (was
  // just branchId -> businessId before) -- purely additive: every existing
  // seed(businessId) call keeps working via the default, and no existing
  // test reads a branch's name, only getCampaignDashboard's new tests do.
  const validBranches = new Map<string, { businessId: string; name: string }>();

  return {
    seed(businessId: string, name = 'Test Branch'): string {
      const id = crypto.randomUUID();
      validBranches.set(id, { businessId, name });
      return id;
    },
    async findById(id: string, businessId: string) {
      const branch = validBranches.get(id);
      return branch && branch.businessId === businessId ? { id, businessId, name: branch.name } : undefined;
    },
  };
}

/** Block 6.7.4 (S6.3 campaign dashboard tests) -- minimal fake for the one
 * method getCampaignDashboard() actually calls, getCampaignStats(). seed()
 * lets a test set the exact {totalCount, redeemedCount, outstandingCount} a
 * real getCampaignStats() query would return for a reward, without
 * reimplementing its SQL. No repository in this codebase has its own unit
 * test today -- every real repo is Drizzle-backed and needs a real Postgres
 * connection to test honestly (see apps/api/vitest.config.ts's own scope
 * comment, and vitest.integration.config.ts for that tier). This fake keeps
 * that boundary: getCampaignStats()'s own SQL is exercised for real in
 * test/integration/loyalty-redemption.integration.test.ts (Block 6.7.4's
 * other half), not reimplemented here. This fake only lets the SERVICE's
 * own handling of whatever the repo returns -- budget math, the "null, not
 * a fabricated zero" rules -- be tested in isolation, same division of
 * responsibility createFakeBranchRepo already draws above. */
function createFakeTransactionRepo() {
  const stats = new Map<string, { totalCount: number; redeemedCount: number; outstandingCount: number }>();

  return {
    seed(rewardId: string, value: { totalCount: number; redeemedCount: number; outstandingCount: number }) {
      stats.set(rewardId, value);
    },
    async getCampaignStats(rewardId: string) {
      return stats.get(rewardId) ?? { totalCount: 0, redeemedCount: 0, outstandingCount: 0 };
    },
  };
}

const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';
const ACTOR = 'actor-user-id';

describe('LoyaltyRewardService', () => {
  let repos: {
    loyaltyRewards: ReturnType<typeof createFakeRewardRepo>;
    branches: ReturnType<typeof createFakeBranchRepo>;
    loyaltyTransactions: ReturnType<typeof createFakeTransactionRepo>;
  };
  let service: LoyaltyRewardService;

  beforeEach(() => {
    repos = {
      loyaltyRewards: createFakeRewardRepo(),
      branches: createFakeBranchRepo(),
      loyaltyTransactions: createFakeTransactionRepo(),
    };
    service = new LoyaltyRewardService(repos as unknown as ConstructorParameters<typeof LoyaltyRewardService>[0]);
  });

  it('create defaults status to active', async () => {
    const reward = await service.create(BUSINESS_A, { name: 'Free coffee', pointsCost: 100 }, ACTOR);
    expect(reward.status).toBe('active');
  });

  it('list excludes inactive rewards by default -- the customer-facing catalog view', async () => {
    const reward = await service.create(BUSINESS_A, { name: 'Retired reward', pointsCost: 50 }, ACTOR);
    await service.update(reward.id, BUSINESS_A, { status: 'inactive' }, ACTOR);

    const activeOnly = await service.list(BUSINESS_A);
    expect(activeOnly).toHaveLength(0);
  });

  it('list includes inactive rewards when includeInactive is set -- the staff management view', async () => {
    const reward = await service.create(BUSINESS_A, { name: 'Retired reward', pointsCost: 50 }, ACTOR);
    await service.update(reward.id, BUSINESS_A, { status: 'inactive' }, ACTOR);

    const all = await service.list(BUSINESS_A, { includeInactive: true });
    expect(all).toHaveLength(1);
  });

  it('list never leaks a reward across businesses', async () => {
    await service.create(BUSINESS_A, { name: 'Business A reward', pointsCost: 10 }, ACTOR);
    await service.create(BUSINESS_B, { name: 'Business B reward', pointsCost: 10 }, ACTOR);

    const listA = await service.list(BUSINESS_A);
    expect(listA.map((r) => r.name)).toEqual(['Business A reward']);
  });

  it('update rejects a reward belonging to a different business (tenant isolation)', async () => {
    const reward = await service.create(BUSINESS_A, { name: 'Gift card', pointsCost: 200 }, ACTOR);
    await expect(
      service.update(reward.id, BUSINESS_B, { name: 'Hijacked' }, ACTOR),
    ).rejects.toMatchObject({ code: 'LOYALTY_REWARD_NOT_FOUND', status: 404 });
  });

  it('remove throws 404 for an unknown reward', async () => {
    await expect(service.remove('does-not-exist', BUSINESS_A, ACTOR)).rejects.toMatchObject({
      code: 'LOYALTY_REWARD_NOT_FOUND',
    });
  });

  // Continuing Development Block 6.6 (S6.1) -- the "config-API gap" fix.
  // Blocks 1-2 widened CreateRewardInput/UpdateRewardInput to accept the ten
  // campaign columns Block 6.1 added to the schema; these are the first real
  // tests of that write path (create + update, numeric/date conversion, and
  // the new branch-scoping validation).

  it('create passes campaign fields through, converting rewardValue/maxBudget to fixed-2-decimal strings and startDate/expiryDate to Date objects', async () => {
    const reward = await service.create(
      BUSINESS_A,
      {
        name: '10% off',
        type: 'discount',
        rewardValue: 9.5,
        maxBudget: 500,
        startDate: '2026-01-01T00:00:00.000Z',
        expiryDate: '2026-12-31T00:00:00.000Z',
        maxRewardsPerDay: 3,
        limitPer: 'visit',
        cooldownSeconds: 60,
      },
      ACTOR,
    );

    expect(reward.rewardValue).toBe('9.50');
    expect(reward.maxBudget).toBe('500.00');
    expect(reward.startDate).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(reward.expiryDate).toEqual(new Date('2026-12-31T00:00:00.000Z'));
    expect(reward.maxRewardsPerDay).toBe(3);
    expect(reward.limitPer).toBe('visit');
    expect(reward.cooldownSeconds).toBe(60);
  });

  it('create leaves every campaign field null when none are provided', async () => {
    const reward = await service.create(BUSINESS_A, { name: 'Plain reward', pointsCost: 20 }, ACTOR);

    expect(reward.branchId).toBeNull();
    expect(reward.rewardValue).toBeNull();
    expect(reward.startDate).toBeNull();
    expect(reward.expiryDate).toBeNull();
    expect(reward.maxRewardsPerDay).toBeNull();
    expect(reward.maxBudget).toBeNull();
    expect(reward.limitPer).toBeNull();
    expect(reward.limitPeriodDays).toBeNull();
    expect(reward.cooldownSeconds).toBeNull();
  });

  it('create rejects when branchId does not belong to the business', async () => {
    const foreignBranchId = repos.branches.seed(BUSINESS_B);

    await expect(
      service.create(BUSINESS_A, { name: 'Wrong branch', pointsCost: 10, branchId: foreignBranchId }, ACTOR),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', status: 404 });
  });

  it('create succeeds and stores branchId when it belongs to the business', async () => {
    const branchId = repos.branches.seed(BUSINESS_A);

    const reward = await service.create(BUSINESS_A, { name: 'Branch reward', pointsCost: 20, branchId }, ACTOR);
    expect(reward.branchId).toBe(branchId);
  });

  it('update only changes the campaign fields included in the patch, leaving the others untouched', async () => {
    const branchId = repos.branches.seed(BUSINESS_A);
    const reward = await service.create(
      BUSINESS_A,
      {
        name: 'Multi-field campaign',
        type: 'voucher',
        rewardValue: 15,
        branchId,
        maxRewardsPerDay: 2,
        cooldownSeconds: 120,
      },
      ACTOR,
    );

    const updated = await service.update(reward.id, BUSINESS_A, { maxBudget: 200 }, ACTOR);

    expect(updated.maxBudget).toBe('200.00'); // the field the patch actually touched
    expect(updated.type).toBe('voucher'); // untouched fields survive the partial update
    expect(updated.rewardValue).toBe('15.00');
    expect(updated.branchId).toBe(branchId);
    expect(updated.maxRewardsPerDay).toBe(2);
    expect(updated.cooldownSeconds).toBe(120);
    expect(updated.name).toBe('Multi-field campaign');
  });

  it('update converts a newly-set rewardValue/maxBudget/date the same way create does', async () => {
    const reward = await service.create(BUSINESS_A, { name: 'Plain', pointsCost: 5 }, ACTOR);

    const updated = await service.update(
      reward.id,
      BUSINESS_A,
      { rewardValue: 3.25, maxBudget: 99, expiryDate: '2027-06-15T00:00:00.000Z' },
      ACTOR,
    );

    expect(updated.rewardValue).toBe('3.25');
    expect(updated.maxBudget).toBe('99.00');
    expect(updated.expiryDate).toEqual(new Date('2027-06-15T00:00:00.000Z'));
  });

  it('update rejects when branchId does not belong to the business', async () => {
    const reward = await service.create(BUSINESS_A, { name: 'Reassign me', pointsCost: 10 }, ACTOR);
    const foreignBranchId = repos.branches.seed(BUSINESS_B);

    await expect(
      service.update(reward.id, BUSINESS_A, { branchId: foreignBranchId }, ACTOR),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND', status: 404 });
  });

  // Continuing Development Block 6.7.4 (S6.3 campaign dashboard tests).
  // getCampaignDashboard() is Block 6.7.1's read-model plus Block 6.7.3's
  // branchName amendment -- these tests are the first real coverage of
  // either. What they verify: the null-vs-fabricated-zero rules, the budget
  // arithmetic, and branch resolution -- all service-layer logic sitting on
  // top of a fake getCampaignStats()/branches.findById(). Whether the real
  // getCampaignStats() SQL itself counts correctly against actual rows is
  // proven separately, against real Postgres, in
  // test/integration/loyalty-redemption.integration.test.ts.

  describe('getCampaignDashboard', () => {
    it('throws 404 for a reward that does not exist', async () => {
      await expect(service.getCampaignDashboard('does-not-exist', BUSINESS_A)).rejects.toMatchObject({
        code: 'LOYALTY_REWARD_NOT_FOUND',
        status: 404,
      });
    });

    it('throws 404 for a reward that belongs to a different business (tenant isolation)', async () => {
      const reward = await service.create(BUSINESS_A, { name: 'Business A only', pointsCost: 10 }, ACTOR);
      await expect(service.getCampaignDashboard(reward.id, BUSINESS_B)).rejects.toMatchObject({
        code: 'LOYALTY_REWARD_NOT_FOUND',
        status: 404,
      });
    });

    it('reports every budget/liability field as null for a points-type reward -- never a fabricated zero', async () => {
      const reward = await service.create(BUSINESS_A, { name: 'Free coffee', pointsCost: 100 }, ACTOR);
      repos.loyaltyTransactions.seed(reward.id, { totalCount: 4, redeemedCount: 1, outstandingCount: 3 });

      const dashboard = await service.getCampaignDashboard(reward.id, BUSINESS_A);

      expect(dashboard.stats.budgetTotal).toBeNull();
      expect(dashboard.stats.budgetUsed).toBeNull();
      expect(dashboard.stats.budgetRemaining).toBeNull();
      expect(dashboard.stats.outstandingLiability).toBeNull();
      // Activity counts and redemption rate are still real for a points
      // reward -- only the money fields are type-gated.
      expect(dashboard.stats.totalCount).toBe(4);
      expect(dashboard.stats.redeemedCount).toBe(1);
      expect(dashboard.stats.outstandingCount).toBe(3);
      expect(dashboard.stats.redemptionRate).toBe(0.25);
    });

    it('computes budgetUsed/budgetRemaining/outstandingLiability from rewardValue, rounded to 2dp', async () => {
      const reward = await service.create(
        BUSINESS_A,
        { name: '10% off', type: 'discount', rewardValue: 9.1, maxBudget: 100 },
        ACTOR,
      );
      // 3 * 9.10 is a classic IEEE 754 floating-point artifact
      // (27.299999999999997) -- this is the case roundMoney() exists for.
      repos.loyaltyTransactions.seed(reward.id, { totalCount: 3, redeemedCount: 2, outstandingCount: 1 });

      const dashboard = await service.getCampaignDashboard(reward.id, BUSINESS_A);

      expect(dashboard.stats.budgetTotal).toBe(100);
      expect(dashboard.stats.budgetUsed).toBe(27.3); // roundMoney(3 * 9.1)
      expect(dashboard.stats.budgetRemaining).toBe(72.7); // 100 - 27.3
      expect(dashboard.stats.outstandingLiability).toBe(9.1); // roundMoney(1 * 9.1)
      expect(dashboard.stats.redemptionRate).toBeCloseTo(0.6667, 3);
    });

    it('leaves budgetTotal/budgetRemaining null when the reward has no maxBudget set, while still reporting budgetUsed', async () => {
      const reward = await service.create(
        BUSINESS_A,
        { name: 'Free dessert', type: 'voucher', rewardValue: 5 },
        ACTOR,
      );
      repos.loyaltyTransactions.seed(reward.id, { totalCount: 2, redeemedCount: 2, outstandingCount: 0 });

      const dashboard = await service.getCampaignDashboard(reward.id, BUSINESS_A);

      expect(dashboard.stats.budgetTotal).toBeNull();
      expect(dashboard.stats.budgetUsed).toBe(10); // roundMoney(2 * 5) -- still meaningful with no cap set
      expect(dashboard.stats.budgetRemaining).toBeNull(); // no cap to subtract from
    });

    it('reports redemptionRate as null (not 0) when totalCount is zero -- "no activity" is not "0% convert"', async () => {
      const reward = await service.create(BUSINESS_A, { name: 'Untouched reward', pointsCost: 50 }, ACTOR);
      // No seed() call -- the fake's default for an un-seeded reward is
      // {totalCount: 0, redeemedCount: 0, outstandingCount: 0}.

      const dashboard = await service.getCampaignDashboard(reward.id, BUSINESS_A);

      expect(dashboard.stats.totalCount).toBe(0);
      expect(dashboard.stats.redemptionRate).toBeNull();
    });

    it('resolves branchName for a branch-scoped reward', async () => {
      const branchId = repos.branches.seed(BUSINESS_A, 'Downtown Branch');
      const reward = await service.create(BUSINESS_A, { name: 'Branch-only reward', pointsCost: 10, branchId }, ACTOR);

      const dashboard = await service.getCampaignDashboard(reward.id, BUSINESS_A);

      expect(dashboard.branchName).toBe('Downtown Branch');
    });

    it('returns branchName null for a business-wide reward (no branchId set)', async () => {
      const reward = await service.create(BUSINESS_A, { name: 'Business-wide reward', pointsCost: 10 }, ACTOR);

      const dashboard = await service.getCampaignDashboard(reward.id, BUSINESS_A);

      expect(dashboard.branchName).toBeNull();
    });
  });
});
