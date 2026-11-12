import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LoyaltyTierService } from './loyalty-tier.service';
import type { LoyaltyTier, NewLoyaltyTier } from '../repositories/loyalty-tier.repository';

function createFakeTierRepo() {
  const tiers = new Map<string, LoyaltyTier>();

  return {
    async findById(id: string, businessId: string) {
      const tier = tiers.get(id);
      return tier && tier.businessId === businessId && !tier.isDeleted ? tier : undefined;
    },
    async listForBusiness(businessId: string) {
      return [...tiers.values()]
        .filter((t) => t.businessId === businessId && !t.isDeleted)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    async create(input: NewLoyaltyTier): Promise<LoyaltyTier> {
      const tier: LoyaltyTier = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        name: input.name,
        minPoints: input.minPoints,
        benefits: input.benefits ?? null,
        sortOrder: input.sortOrder ?? 0,
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
        updatedAt: new Date(),
        updatedBy: input.updatedBy ?? null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
      };
      tiers.set(tier.id, tier);
      return tier;
    },
    async update(id: string, businessId: string, patch: Partial<NewLoyaltyTier>, updatedBy: string) {
      const tier = tiers.get(id);
      if (!tier || tier.businessId !== businessId) return undefined;
      Object.assign(tier, patch, { updatedBy, updatedAt: new Date() });
      return tier;
    },
    async softDelete(id: string, businessId: string, deletedBy: string) {
      const tier = tiers.get(id);
      if (tier && tier.businessId === businessId) {
        tier.isDeleted = true;
        tier.deletedAt = new Date();
        tier.deletedBy = deletedBy;
      }
    },
  };
}

const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';
const ACTOR = 'actor-user-id';

describe('LoyaltyTierService', () => {
  let repos: { loyaltyTiers: ReturnType<typeof createFakeTierRepo> };
  let service: LoyaltyTierService;

  beforeEach(() => {
    repos = { loyaltyTiers: createFakeTierRepo() };
    service = new LoyaltyTierService(repos as unknown as ConstructorParameters<typeof LoyaltyTierService>[0]);
  });

  it('create defaults sortOrder to 0 when not given', async () => {
    const tier = await service.create(BUSINESS_A, { name: 'Silver', minPoints: 100 }, ACTOR);
    expect(tier.sortOrder).toBe(0);
  });

  it('returns 409 for a wrapped postgres.js duplicate tier-name constraint on create', async () => {
    const driverError = Object.assign(new Error('unique violation'), {
      code: '23505',
      constraint_name: 'loyalty_tiers_business_name_key',
    });
    vi.spyOn(repos.loyaltyTiers, 'create').mockRejectedValueOnce(
      Object.assign(new Error('Drizzle query failed'), { cause: driverError }),
    );

    await expect(service.create(BUSINESS_A, { name: 'Gold', minPoints: 100 }, ACTOR)).rejects.toMatchObject({
      status: 409,
      code: 'LOYALTY_TIER_ALREADY_EXISTS',
      message: 'A loyalty tier with this name already exists.',
    });
  });

  it('returns 409 for a pg-style duplicate tier-name constraint on update', async () => {
    const tier = await service.create(BUSINESS_A, { name: 'Silver', minPoints: 100 }, ACTOR);
    vi.spyOn(repos.loyaltyTiers, 'update').mockRejectedValueOnce(
      Object.assign(new Error('unique violation'), {
        code: '23505',
        constraint: 'loyalty_tiers_business_name_key',
      }),
    );

    await expect(service.update(tier.id, BUSINESS_A, { name: 'Gold' }, ACTOR)).rejects.toMatchObject({
      status: 409,
      code: 'LOYALTY_TIER_ALREADY_EXISTS',
    });
  });

  it('does not reinterpret a different unique constraint as a tier-name conflict', async () => {
    const differentConstraint = Object.assign(new Error('different unique violation'), {
      code: '23505',
      constraint_name: 'some_other_unique_key',
    });
    vi.spyOn(repos.loyaltyTiers, 'create').mockRejectedValueOnce(differentConstraint);

    await expect(service.create(BUSINESS_A, { name: 'Gold', minPoints: 100 }, ACTOR)).rejects.toBe(
      differentConstraint,
    );
  });

  it('does not infer a tier-name conflict from a message without matching SQLSTATE', async () => {
    const unrelated = Object.assign(new Error('loyalty_tiers_business_name_key'), {
      code: '23503',
      constraint_name: 'loyalty_tiers_business_name_key',
    });
    vi.spyOn(repos.loyaltyTiers, 'create').mockRejectedValueOnce(unrelated);

    await expect(service.create(BUSINESS_A, { name: 'Gold', minPoints: 100 }, ACTOR)).rejects.toBe(
      unrelated,
    );
  });

  it('keeps not-found update errors as 404, not duplicate-name conflicts', async () => {
    await expect(service.update('nonexistent', BUSINESS_A, { name: 'Gold' }, ACTOR)).rejects.toMatchObject({
      status: 404,
      code: 'LOYALTY_TIER_NOT_FOUND',
    });
  });

  it('list returns tiers sorted by sortOrder, scoped to one business', async () => {
    await service.create(BUSINESS_A, { name: 'Gold', minPoints: 500, sortOrder: 2 }, ACTOR);
    await service.create(BUSINESS_A, { name: 'Silver', minPoints: 100, sortOrder: 1 }, ACTOR);
    await service.create(BUSINESS_B, { name: 'Other Business Tier', minPoints: 0, sortOrder: 0 }, ACTOR);

    const list = await service.list(BUSINESS_A);
    expect(list.map((t) => t.name)).toEqual(['Silver', 'Gold']);
  });

  it('update rejects a tier belonging to a different business (tenant isolation)', async () => {
    const tier = await service.create(BUSINESS_A, { name: 'Gold', minPoints: 500 }, ACTOR);
    await expect(
      service.update(tier.id, BUSINESS_B, { name: 'Hijacked' }, ACTOR),
    ).rejects.toMatchObject({ code: 'LOYALTY_TIER_NOT_FOUND', status: 404 });
  });

  it('remove soft-deletes a tier so it no longer appears in list()', async () => {
    const tier = await service.create(BUSINESS_A, { name: 'Bronze', minPoints: 0 }, ACTOR);
    await service.remove(tier.id, BUSINESS_A, ACTOR);

    const list = await service.list(BUSINESS_A);
    expect(list).toHaveLength(0);
  });

  it('remove throws 404 for an unknown tier instead of silently no-op-ing', async () => {
    await expect(service.remove('does-not-exist', BUSINESS_A, ACTOR)).rejects.toMatchObject({
      code: 'LOYALTY_TIER_NOT_FOUND',
    });
  });
});
