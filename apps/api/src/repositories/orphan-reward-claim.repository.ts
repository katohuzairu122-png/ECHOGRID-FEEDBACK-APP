import { and, desc, eq, ne } from 'drizzle-orm';
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

  async lockForUpdate(id: string): Promise<OrphanRewardClaim | undefined> {
    const [row] = await this.db
      .select()
      .from(orphanRewardClaims)
      .where(eq(orphanRewardClaims.id, id))
      .for('update');
    return row;
  }

  async reserveAvailable(id: string): Promise<OrphanRewardClaim | undefined> {
    const [row] = await this.db
      .update(orphanRewardClaims)
      .set({ status: 'reserved' })
      .where(
        and(
          eq(orphanRewardClaims.id, id),
          eq(orphanRewardClaims.status, 'available'),
        ),
      )
      .returning();
    return row;
  }

  async releaseReserved(id: string): Promise<OrphanRewardClaim | undefined> {
    const [row] = await this.db
      .update(orphanRewardClaims)
      .set({ status: 'available' })
      .where(
        and(
          eq(orphanRewardClaims.id, id),
          eq(orphanRewardClaims.status, 'reserved'),
        ),
      )
      .returning();
    return row;
  }

  async reverseSettled(
    id: string,
    reversedAt: Date,
  ): Promise<OrphanRewardClaim | undefined> {
    const [row] = await this.db
      .update(orphanRewardClaims)
      .set({
        status: 'reversed',
        reversedAt,
      })
      .where(
        and(
          eq(orphanRewardClaims.id, id),
          eq(orphanRewardClaims.status, 'settled'),
        ),
      )
      .returning();
    return row;
  }

  async settleReserved(
    id: string,
    settledAt: Date,
  ): Promise<OrphanRewardClaim | undefined> {
    const [row] = await this.db
      .update(orphanRewardClaims)
      .set({
        status: 'settled',
        settledAt,
      })
      .where(
        and(
          eq(orphanRewardClaims.id, id),
          eq(orphanRewardClaims.status, 'reserved'),
        ),
      )
      .returning();
    return row;
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

  async existsAvailableForCustomerExcludingBusiness(
    customerId: string,
    excludedOriginBusinessId: string,
  ): Promise<boolean> {
    const row = await this.db.query.orphanRewardClaims.findFirst({
      where: and(
        eq(orphanRewardClaims.customerId, customerId),
        eq(orphanRewardClaims.status, 'available'),
        ne(orphanRewardClaims.originBusinessId, excludedOriginBusinessId),
      ),
      columns: { id: true },
    });
    return row !== undefined;
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
