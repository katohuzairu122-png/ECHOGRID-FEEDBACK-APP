import { eq, and, desc, isNull } from 'drizzle-orm';
import { loyaltyTransactions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type LoyaltyTransaction = typeof loyaltyTransactions.$inferSelect;
export type NewLoyaltyTransaction = typeof loyaltyTransactions.$inferInsert;

export class LoyaltyTransactionRepository extends BaseRepository {
  async create(input: NewLoyaltyTransaction): Promise<LoyaltyTransaction> {
    const [row] = await this.db.insert(loyaltyTransactions).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async listForAccount(
    loyaltyAccountId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
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

  /** WHERE guards on `redemptionConfirmedAt IS NULL` so this is the actual
   * source of truth for "did THIS call win the confirmation," not a
   * check-then-act race against a value read earlier -- two concurrent
   * confirms of the same code must not both succeed and hand out the reward
   * twice. Returns undefined for "already confirmed" exactly the same as
   * "doesn't exist"; the caller (LoyaltyRedemptionService.confirmRedemption)
   * has already ruled out "doesn't exist" via a preceding lookup, so it
   * attributes undefined here to a lost race. */
  async confirmRedemption(id: string): Promise<LoyaltyTransaction | undefined> {
    const [row] = await this.db
      .update(loyaltyTransactions)
      .set({ redemptionConfirmedAt: new Date() })
      .where(and(eq(loyaltyTransactions.id, id), isNull(loyaltyTransactions.redemptionConfirmedAt)))
      .returning();
    return row;
  }
}
