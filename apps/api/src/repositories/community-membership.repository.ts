import { assertCommunityMembershipWrite, assertCommunityMembershipOperation, type CommunityMembershipWritePermit } from '../community/community-membership-controls';
import { and, eq } from 'drizzle-orm';
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

  async create(input: NewCommunityMembership, permit?: CommunityMembershipWritePermit): Promise<CommunityMembership> {
    assertCommunityMembershipWrite(this.db, input.customerId, input.status ?? 'active', permit);
    if ((input.status ?? 'active') === 'active') assertCommunityMembershipOperation(permit, 'join');
    if (input.status === 'inactive') assertCommunityMembershipOperation(permit, 'clearance');
    const [row] = await this.db.insert(communityMemberships).values(input).returning();
    if (!row) throw new Error('Community membership insert returned no row');
    return row;
  }

  async updateStatus(
    customerId: string,
    patch: Partial<
      Pick<
        NewCommunityMembership,
        'status' | 'policyVersion' | 'joinedAt' | 'leftAt' | 'suspendedAt'
      >
    >,
    permit?: CommunityMembershipWritePermit,
  ): Promise<CommunityMembership | undefined> {
    assertCommunityMembershipWrite(this.db, customerId, patch.status, permit);
    const protectedWrite = patch.status === 'active' || patch.status === 'inactive';
    const previous = protectedWrite ? await this.findByCustomerId(customerId) : undefined;
    if (protectedWrite) {
      if (!previous) return undefined;
      const operation = patch.status === 'inactive'
        ? previous.status === 'suspended' ? 'clearance' : null
        : previous.status === 'inactive' ? 'restore' : previous.status === 'left' ? 'rejoin' : null;
      assertCommunityMembershipOperation(permit, operation);
    }
    const [row] = await this.db
      .update(communityMemberships)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(communityMemberships.customerId, customerId), previous ? eq(communityMemberships.status, previous.status) : undefined))
      .returning();
    return row;
  }
}
