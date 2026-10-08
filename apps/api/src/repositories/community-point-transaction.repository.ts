import { and, desc, eq, type SQL } from 'drizzle-orm';
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

  async listPlatform(
    filters: {
      customerId?: string;
      accountId?: string;
      businessId?: string;
      branchId?: string;
      type?: CommunityPointTransaction['type'];
      sourceType?: CommunityPointTransaction['sourceType'];
    } = {},
    options: { limit?: number; offset?: number } = {},
  ): Promise<CommunityPointTransaction[]> {
    const conditions: SQL[] = [];
    if (filters.customerId) conditions.push(eq(communityPointTransactions.customerId, filters.customerId));
    if (filters.accountId) conditions.push(eq(communityPointTransactions.accountId, filters.accountId));
    if (filters.businessId) conditions.push(eq(communityPointTransactions.businessId, filters.businessId));
    if (filters.branchId) conditions.push(eq(communityPointTransactions.branchId, filters.branchId));
    if (filters.type) conditions.push(eq(communityPointTransactions.type, filters.type));
    if (filters.sourceType) conditions.push(eq(communityPointTransactions.sourceType, filters.sourceType));

    return this.db.query.communityPointTransactions.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(communityPointTransactions.createdAt)],
      limit: Math.min(options.limit ?? 100, 200),
      offset: options.offset ?? 0,
    });
  }

  async findAdminAdjustmentBySourceRef(
    sourceRef: string,
  ): Promise<CommunityPointTransaction | undefined> {
    return this.db.query.communityPointTransactions.findFirst({
      where: and(
        eq(communityPointTransactions.type, 'admin_adjustment'),
        eq(communityPointTransactions.sourceType, 'admin_adjustment'),
        eq(communityPointTransactions.sourceRef, sourceRef),
      ),
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
