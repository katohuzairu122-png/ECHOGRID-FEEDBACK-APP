import { eq, sql } from 'drizzle-orm';
import { communityPointAccounts } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CommunityPointAccount = typeof communityPointAccounts.$inferSelect;
export type NewCommunityPointAccount = typeof communityPointAccounts.$inferInsert;

export class CommunityPointAccountRepository extends BaseRepository {
  async findById(id: string): Promise<CommunityPointAccount | undefined> {
    return this.db.query.communityPointAccounts.findFirst({
      where: eq(communityPointAccounts.id, id),
    });
  }

  async findByCustomerId(customerId: string): Promise<CommunityPointAccount | undefined> {
    return this.db.query.communityPointAccounts.findFirst({
      where: eq(communityPointAccounts.customerId, customerId),
    });
  }

  async create(input: NewCommunityPointAccount): Promise<CommunityPointAccount> {
    const [row] = await this.db.insert(communityPointAccounts).values(input).returning();
    if (!row) throw new Error('Community Point account insert returned no row');
    return row;
  }

  async updateStatus(
    id: string,
    status: CommunityPointAccount['status'],
  ): Promise<CommunityPointAccount | undefined> {
    const [row] = await this.db
      .update(communityPointAccounts)
      .set({ status, updatedAt: new Date() })
      .where(eq(communityPointAccounts.id, id))
      .returning();
    return row;
  }

  async incrementBalance(
    id: string,
    delta: number,
  ): Promise<CommunityPointAccount | undefined> {
    const [row] = await this.db
      .update(communityPointAccounts)
      .set({
        pointsBalance: sql`${communityPointAccounts.pointsBalance} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(communityPointAccounts.id, id))
      .returning();
    return row;
  }
}
