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
        .sort((a, b) => a.pointsCost - b.pointsCost);
    },
    async create(input: NewLoyaltyReward): Promise<LoyaltyReward> {
      const reward: LoyaltyReward = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        name: input.name,
        description: input.description ?? null,
        pointsCost: input.pointsCost,
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
      Object.assign(reward, patch, { updatedBy, updatedAt: new Date() });
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

const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';
const ACTOR = 'actor-user-id';

describe('LoyaltyRewardService', () => {
  let repos: { loyaltyRewards: ReturnType<typeof createFakeRewardRepo> };
  let service: LoyaltyRewardService;

  beforeEach(() => {
    repos = { loyaltyRewards: createFakeRewardRepo() };
    service = new LoyaltyRewardService(repos);
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
});
