import { eq, and, desc } from 'drizzle-orm';
import { loyaltyTransactions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type LoyaltyTransaction = typeof loyaltyTransactions.$inferSelect;
export type NewLoyaltyTransaction = typeof loyaltyTransactions.$inferInsert;

export class LoyaltyTransactionRepository extends BaseRepository {
  async create(input: NewLoyaltyTransaction): Promise<LoyaltyTransaction> {
    const [row] = await this.db.insert(loyaltyTransactions).values(input).returning();
    return row;
  }

  async listForAccount(
    loyaltyAccountId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LoyaltyTransaction[]> {
    return this.db.query.loyaltyTransactions.findMany({
      where: eq(loyaltyTransactions.loyaltyAccountId, loyaltyAccountId),
      limit: options.limit,
      offset: options.offset,
      orderBy: desc(loyaltyTransactions.createdAt),
    });
  }

  /** Looks up an in-flight redemption by the code staff verifies at the
   * counter -- confirmedAt filter distinguishes "pending" from "already
   * confirmed" without a separate status column (Block 4 uses this). */
  async findByRedemptionCode(code: string): Promise<LoyaltyTransaction | undefined> {
    return this.db.query.loyaltyTransactions.findFirst({
      where: eq(loyaltyTransactions.redemptionCode, code),
    });
  }

  async confirmRedemption(id: string): Promise<LoyaltyTransaction | undefined> {
    const [row] = await this.db
      .update(loyaltyTransactions)
      .set({ redemptionConfirmedAt: new Date() })
      .where(and(eq(loyaltyTransactions.id, id)))
      .returning();
    return row;
  }
}
