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
  const validBranches = new Map<string, string>(); // branchId -> businessId

  return {
    seed(businessId: string): string {
      const id = crypto.randomUUID();
      validBranches.set(id, businessId);
      return id;
    },
    async findById(id: string, businessId: string) {
      return validBranches.get(id) === businessId ? { id, businessId } : undefined;
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
  };
  let service: LoyaltyRewardService;

  beforeEach(() => {
    repos = { loyaltyRewards: createFakeRewardRepo(), branches: createFakeBranchRepo() };
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
});
