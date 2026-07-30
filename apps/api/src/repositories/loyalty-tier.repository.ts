import { eq, and, asc } from 'drizzle-orm';
import { loyaltyTiers } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { Patch } from '../lib/types';

export type LoyaltyTier = typeof loyaltyTiers.$inferSelect;
export type NewLoyaltyTier = typeof loyaltyTiers.$inferInsert;

export class LoyaltyTierRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<LoyaltyTier | undefined> {
    return this.db.query.loyaltyTiers.findFirst({
      where: and(
        eq(loyaltyTiers.id, id),
        eq(loyaltyTiers.businessId, businessId),
        eq(loyaltyTiers.isDeleted, false),
      ),
    });
  }

  async listForBusiness(businessId: string): Promise<LoyaltyTier[]> {
    return this.db.query.loyaltyTiers.findMany({
      where: and(eq(loyaltyTiers.businessId, businessId), eq(loyaltyTiers.isDeleted, false)),
      orderBy: asc(loyaltyTiers.sortOrder),
    });
  }

  /** Highest tier whose minPoints threshold the given balance meets --
   * used by the points engine (Block 3) to recompute a loyalty_account's
   * tierId after every earning transaction. */
  async findHighestEligible(businessId: string, points: number): Promise<LoyaltyTier | undefined> {
    const tiers = await this.listForBusiness(businessId);
    return tiers
      .filter((t) => t.minPoints <= points)
      .sort((a, b) => b.minPoints - a.minPoints)[0];
  }

  async create(input: NewLoyaltyTier): Promise<LoyaltyTier> {
    const [row] = await this.db.insert(loyaltyTiers).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async update(
    id: string,
    businessId: string,
    patch: Patch<Omit<NewLoyaltyTier, 'id' | 'businessId'>>,
    updatedBy: string,
  ): Promise<LoyaltyTier | undefined> {
    const [row] = await this.db
      .update(loyaltyTiers)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(and(eq(loyaltyTiers.id, id), eq(loyaltyTiers.businessId, businessId)))
      .returning();
    return row;
  }

  async softDelete(id: string, businessId: string, deletedBy: string): Promise<void> {
    await this.db
      .update(loyaltyTiers)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
      .where(and(eq(loyaltyTiers.id, id), eq(loyaltyTiers.businessId, businessId)));
  }
}
