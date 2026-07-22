import type { Repositories, LoyaltyTier } from '../repositories';
import { AppError } from '../lib/errors';

/** create()'s shape: name/minPoints required (matches createTierSchema),
 * benefits/sortOrder optional. */
export interface CreateTierInput {
  name: string;
  minPoints: number;
  benefits?: string | undefined;
  sortOrder?: number | undefined;
}

/** update()'s shape: every field optional (matches updateTierSchema, a
 * `.partial()` of createTierSchema). */
export interface UpdateTierInput {
  name?: string | undefined;
  minPoints?: number | undefined;
  benefits?: string | undefined;
  sortOrder?: number | undefined;
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

  async create(businessId: string, input: CreateTierInput, createdBy: string): Promise<LoyaltyTier> {
    return this.repos.loyaltyTiers.create({
      businessId,
      name: input.name,
      minPoints: input.minPoints,
      benefits: input.benefits,
      sortOrder: input.sortOrder ?? 0,
      createdBy,
    });
  }

  async update(id: string, businessId: string, patch: UpdateTierInput, updatedBy: string): Promise<LoyaltyTier> {
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
