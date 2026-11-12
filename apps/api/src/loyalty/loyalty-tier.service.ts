import type { Repositories, LoyaltyTier } from '../repositories';
import { AppError } from '../lib/errors';

/**
 * PostgreSQL 23505 is only a loyalty-tier name conflict when it names our
 * business/name unique index. Drizzle can wrap the driver error in a cause;
 * accept both pg's `constraint` and postgres.js's `constraint_name`.
 * Never infer a conflict from message text or translate other DB failures.
 */
function isTierNameConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as Record<string, unknown>;
    if (
      candidate.code === '23505' &&
      (candidate.constraint === 'loyalty_tiers_business_name_key' ||
        candidate.constraint_name === 'loyalty_tiers_business_name_key')
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function throwTierWriteError(error: unknown): never {
  if (isTierNameConflict(error)) {
    throw new AppError('A loyalty tier with this name already exists.', 409, 'LOYALTY_TIER_ALREADY_EXISTS');
  }
  throw error;
}

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
    try {
      return await this.repos.loyaltyTiers.create({
        businessId,
        name: input.name,
        minPoints: input.minPoints,
        benefits: input.benefits,
        sortOrder: input.sortOrder ?? 0,
        createdBy,
      });
    } catch (error) {
      return throwTierWriteError(error);
    }
  }

  async update(id: string, businessId: string, patch: UpdateTierInput, updatedBy: string): Promise<LoyaltyTier> {
    try {
      const tier = await this.repos.loyaltyTiers.update(id, businessId, patch, updatedBy);
      if (!tier) throw new AppError('Loyalty tier not found.', 404, 'LOYALTY_TIER_NOT_FOUND');
      return tier;
    } catch (error) {
      return throwTierWriteError(error);
    }
  }

  async remove(id: string, businessId: string, deletedBy: string): Promise<void> {
    const existing = await this.repos.loyaltyTiers.findById(id, businessId);
    if (!existing) throw new AppError('Loyalty tier not found.', 404, 'LOYALTY_TIER_NOT_FOUND');
    await this.repos.loyaltyTiers.softDelete(id, businessId, deletedBy);
  }
}
