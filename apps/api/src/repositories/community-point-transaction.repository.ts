import { and, desc, eq } from 'drizzle-orm';
import { communityPointTransactions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CommunityPointTransaction = typeof communityPointTransactions.$inferSelect;
export type NewCommunityPointTransaction = typeof communityPointTransactions.$inferInsert;

export class CommunityPointTransactionRepository extends BaseRepository {
  async findById(id: string): Promise<CommunityPointTransaction | undefined> {
    return this.db.query.communityPointTransactions.findFirst({
      where: eq(communityPointTransactions.id, id),
    });
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CommunityPointTransaction | undefined> {
    return this.db.query.communityPointTransactions.findFirst({
      where: eq(communityPointTransactions.idempotencyKey, idempotencyKey),
    });
  }

  async findReversalOf(
    transactionId: string,
  ): Promise<CommunityPointTransaction | undefined> {
    return this.db.query.communityPointTransactions.findFirst({
      where: eq(communityPointTransactions.reversalOf, transactionId),
    });
  }

  async createIdempotent(
    input: NewCommunityPointTransaction,
  ): Promise<{ transaction: CommunityPointTransaction; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(communityPointTransactions)
      .values(input)
      .onConflictDoNothing({ target: communityPointTransactions.idempotencyKey })
      .returning();

    if (inserted) return { transaction: inserted, inserted: true };

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      throw new Error(
        'Community Point transaction conflict did not resolve to an existing row',
      );
    }
    return { transaction: existing, inserted: false };
  }

  async listForAccount(
    accountId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<CommunityPointTransaction[]> {
    return this.db.query.communityPointTransactions.findMany({
      where: eq(communityPointTransactions.accountId, accountId),
      orderBy: [desc(communityPointTransactions.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }

  async listForCustomer(
    customerId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<CommunityPointTransaction[]> {
    return this.db.query.communityPointTransactions.findMany({
      where: eq(communityPointTransactions.customerId, customerId),
      orderBy: [desc(communityPointTransactions.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }

  async findByAwardDecision(
    awardDecisionId: string,
  ): Promise<CommunityPointTransaction | undefined> {
    return this.db.query.communityPointTransactions.findFirst({
      where: and(
        eq(communityPointTransactions.awardDecisionId, awardDecisionId),
        eq(communityPointTransactions.type, 'earn'),
      ),
    });
  }

  // No update/delete methods by design: Community Point transactions are append-only.
}
