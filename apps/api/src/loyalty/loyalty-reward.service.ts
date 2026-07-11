import type { Repositories, LoyaltyReward } from '../repositories';
import { AppError } from '../lib/errors';

export interface UpsertRewardInput {
  name?: string;
  description?: string;
  pointsCost?: number;
  status?: 'active' | 'inactive';
}

/** Reward catalog configuration (rewards:manage) -- mirrors LoyaltyTierService's shape. */
export class LoyaltyRewardService {
  constructor(private readonly repos: Pick<Repositories, 'loyaltyRewards'>) {}

  /** Customer-facing catalog and the staff config screen both call this;
   * `includeInactive` distinguishes the two (see repository doc comment). */
  async list(businessId: string, options: { includeInactive?: boolean } = {}): Promise<LoyaltyReward[]> {
    return this.repos.loyaltyRewards.listForBusiness(businessId, options);
  }

  async create(
    businessId: string,
    input: Required<Pick<UpsertRewardInput, 'name' | 'pointsCost'>> & UpsertRewardInput,
    createdBy: string,
  ): Promise<LoyaltyReward> {
    return this.repos.loyaltyRewards.create({
      businessId,
      name: input.name,
      description: input.description,
      pointsCost: input.pointsCost,
      createdBy,
    });
  }

  async update(
    id: string,
    businessId: string,
    patch: UpsertRewardInput,
    updatedBy: string,
  ): Promise<LoyaltyReward> {
    const reward = await this.repos.loyaltyRewards.update(id, businessId, patch, updatedBy);
    if (!reward) throw new AppError('Reward not found.', 404, 'LOYALTY_REWARD_NOT_FOUND');
    return reward;
  }

  async remove(id: string, businessId: string, deletedBy: string): Promise<void> {
    const existing = await this.repos.loyaltyRewards.findById(id, businessId);
    if (!existing) throw new AppError('Reward not found.', 404, 'LOYALTY_REWARD_NOT_FOUND');
    await this.repos.loyaltyRewards.softDelete(id, businessId, deletedBy);
  }
}
