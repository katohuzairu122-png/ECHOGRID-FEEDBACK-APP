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

  /** Continuing Development Block 6.4 (S5.8 + S6.8 atomic limit
   * enforcement). Locks the row for the life of the caller's transaction --
   * `SELECT ... FOR UPDATE` is only meaningful inside one, and every caller
   * (LoyaltyRedemptionService.issue()/redeem()) already wraps its work in
   * db.transaction(). Serializes concurrent issue()/redeem() attempts
   * against the SAME reward, so a daily-count/budget check made after
   * acquiring the lock sees a result consistent with every transaction that
   * has already committed -- without this, two concurrent requests could
   * both read "0 issued today" before either commits, and both pass a
   * maxRewardsPerDay: 1 check. Uses the core query builder rather than this
   * file's usual db.query.loyaltyRewards.findFirst, because Drizzle's
   * relational query API doesn't expose .for('update') -- same reasoning
   * confirmRedemption() in loyalty-transaction.repository.ts already
   * established for mixing builder styles within one repository file. */
  async lockForUpdate(id: string, businessId: string): Promise<LoyaltyReward | undefined> {
    const [reward] = await this.db
      .select()
      .from(loyaltyRewards)
      .where(
        and(eq(loyaltyRewards.id, id), eq(loyaltyRewards.businessId, businessId), eq(loyaltyRewards.isDeleted, false)),
      )
      .for('update');
    return reward;
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
