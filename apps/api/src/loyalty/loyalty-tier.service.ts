import type { Repositories, LoyaltyTier } from '../repositories';
import { AppError } from '../lib/errors';

export interface UpsertTierInput {
  name?: string;
  minPoints?: number;
  benefits?: string;
  sortOrder?: number;
}

/**
 * Tier configuration (rewards:manage) -- thin over LoyaltyTierRepository,
 * kept as its own service (rather than inlined in routes) for the same
 * reason every other feature module does this: route handlers translate
 * HTTP <-> business methods and stay free of query/validation logic.
 */
export class LoyaltyTierService {
  constructor(private readonly repos: Pick<Repositories, 'loyaltyTiers'>) {}

  async list(businessId: string): Promise<LoyaltyTier[]> {
    return this.repos.loyaltyTiers.listForBusiness(businessId);
  }

  async create(businessId: string, input: Required<Pick<UpsertTierInput, 'name' | 'minPoints'>> & UpsertTierInput, createdBy: string): Promise<LoyaltyTier> {
    return this.repos.loyaltyTiers.create({
      businessId,
      name: input.name,
      minPoints: input.minPoints,
      benefits: input.benefits,
      sortOrder: input.sortOrder ?? 0,
      createdBy,
    });
  }

  async update(id: string, businessId: string, patch: UpsertTierInput, updatedBy: string): Promise<LoyaltyTier> {
    const tier = await this.repos.loyaltyTiers.update(id, businessId, patch, updatedBy);
    if (!tier) throw new AppError('Loyalty tier not found.', 404, 'LOYALTY_TIER_NOT_FOUND');
    return tier;
  }

  async remove(id: string, businessId: string, deletedBy: string): Promise<void> {
    const existing = await this.repos.loyaltyTiers.findById(id, businessId);
    if (!existing) throw new AppError('Loyalty tier not found.', 404, 'LOYALTY_TIER_NOT_FOUND');
    await this.repos.loyaltyTiers.softDelete(id, businessId, deletedBy);
  }
}
