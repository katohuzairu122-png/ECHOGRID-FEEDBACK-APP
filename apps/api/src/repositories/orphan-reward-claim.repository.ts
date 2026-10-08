import { and, desc, eq } from 'drizzle-orm';
import { orphanRewardClaims } from '../db/schema';
import { BaseRepository } from './base.repository';

export type OrphanRewardClaim = typeof orphanRewardClaims.$inferSelect;
export type NewOrphanRewardClaim = typeof orphanRewardClaims.$inferInsert;

export class OrphanRewardClaimRepository extends BaseRepository {
  async findById(id: string): Promise<OrphanRewardClaim | undefined> {
    return this.db.query.orphanRewardClaims.findFirst({
      where: eq(orphanRewardClaims.id, id),
    });
  }

  async findByIdForCustomer(
    id: string,
    customerId: string,
  ): Promise<OrphanRewardClaim | undefined> {
    return this.db.query.orphanRewardClaims.findFirst({
      where: and(
        eq(orphanRewardClaims.id, id),
        eq(orphanRewardClaims.customerId, customerId),
      ),
    });
  }

  async findBySourceTransaction(
    originLoyaltyTransactionId: string,
  ): Promise<OrphanRewardClaim | undefined> {
    return this.db.query.orphanRewardClaims.findFirst({
      where: eq(
        orphanRewardClaims.originLoyaltyTransactionId,
        originLoyaltyTransactionId,
      ),
    });
  }

  async createIdempotent(
    input: NewOrphanRewardClaim,
  ): Promise<{ claim: OrphanRewardClaim; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(orphanRewardClaims)
      .values(input)
      .onConflictDoNothing({
        target: orphanRewardClaims.originLoyaltyTransactionId,
      })
      .returning();

    if (inserted) return { claim: inserted, inserted: true };

    const existing = await this.findBySourceTransaction(
      input.originLoyaltyTransactionId,
    );
    if (!existing) {
      throw new Error(
        'Orphan reward claim conflict did not resolve to an existing row',
      );
    }
    return { claim: existing, inserted: false };
  }

  async listForCustomer(
    customerId: string,
    options: {
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<OrphanRewardClaim[]> {
    return this.db.query.orphanRewardClaims.findMany({
      where: eq(orphanRewardClaims.customerId, customerId),
      orderBy: [desc(orphanRewardClaims.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }
}
