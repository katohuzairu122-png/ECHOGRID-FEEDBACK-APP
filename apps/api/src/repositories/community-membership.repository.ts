import { eq } from 'drizzle-orm';
import { communityMemberships } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CommunityMembership = typeof communityMemberships.$inferSelect;
export type NewCommunityMembership = typeof communityMemberships.$inferInsert;

export class CommunityMembershipRepository extends BaseRepository {
  async findByCustomerId(customerId: string): Promise<CommunityMembership | undefined> {
    return this.db.query.communityMemberships.findFirst({
      where: eq(communityMemberships.customerId, customerId),
    });
  }

  async findActiveByCustomerId(customerId: string): Promise<CommunityMembership | undefined> {
    return this.db.query.communityMemberships.findFirst({
      where: (row, { and, eq }) =>
        and(eq(row.customerId, customerId), eq(row.status, 'active')),
    });
  }

  async create(input: NewCommunityMembership): Promise<CommunityMembership> {
    const [row] = await this.db.insert(communityMemberships).values(input).returning();
    if (!row) throw new Error('Community membership insert returned no row');
    return row;
  }

  async updateStatus(
    customerId: string,
    patch: Pick<
      NewCommunityMembership,
      'status' | 'policyVersion' | 'joinedAt' | 'leftAt' | 'suspendedAt'
    >,
  ): Promise<CommunityMembership | undefined> {
    const [row] = await this.db
      .update(communityMemberships)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(communityMemberships.customerId, customerId))
      .returning();
    return row;
  }
}
