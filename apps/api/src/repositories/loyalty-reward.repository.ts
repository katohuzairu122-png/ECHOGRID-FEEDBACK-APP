import { eq, and } from 'drizzle-orm';
import { loyaltyRewards } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { Patch } from '../lib/types';

export type LoyaltyReward = typeof loyaltyRewards.$inferSelect;
export type NewLoyaltyReward = typeof loyaltyRewards.$inferInsert;

export class LoyaltyRewardRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<LoyaltyReward | undefined> {
    return this.db.query.loyaltyRewards.findFirst({
      where: and(
        eq(loyaltyRewards.id, id),
        eq(loyaltyRewards.businessId, businessId),
        eq(loyaltyRewards.isDeleted, false),
      ),
    });
  }

  /** Active-only by default (the customer-facing catalog never shows a
   * retired reward); pass includeInactive for the staff management screen,
   * which needs to see and reactivate retired rewards too. */
  async listForBusiness(
    businessId: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<LoyaltyReward[]> {
    return this.db.query.loyaltyRewards.findMany({
      where: and(
        eq(loyaltyRewards.businessId, businessId),
        eq(loyaltyRewards.isDeleted, false),
        options.includeInactive ? undefined : eq(loyaltyRewards.status, 'active'),
      ),
      orderBy: (r, { asc }) => [asc(r.pointsCost)],
    });
  }

  async create(input: NewLoyaltyReward): Promise<LoyaltyReward> {
    const [row] = await this.db.insert(loyaltyRewards).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async update(
    id: string,
    businessId: string,
    patch: Patch<Omit<NewLoyaltyReward, 'id' | 'businessId'>>,
    updatedBy: string,
  ): Promise<LoyaltyReward | undefined> {
    const [row] = await this.db
      .update(loyaltyRewards)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(and(eq(loyaltyRewards.id, id), eq(loyaltyRewards.businessId, businessId)))
      .returning();
    return row;
  }

  async softDelete(id: string, businessId: string, deletedBy: string): Promise<void> {
    await this.db
      .update(loyaltyRewards)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
      .where(and(eq(loyaltyRewards.id, id), eq(loyaltyRewards.businessId, businessId)));
  }
}
