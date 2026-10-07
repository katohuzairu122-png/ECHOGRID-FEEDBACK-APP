import { and, desc, eq } from 'drizzle-orm';
import { communityPointAwardDecisions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CommunityPointAwardDecision = typeof communityPointAwardDecisions.$inferSelect;
export type NewCommunityPointAwardDecision = typeof communityPointAwardDecisions.$inferInsert;

export class CommunityPointAwardDecisionRepository extends BaseRepository {
  async findById(id: string): Promise<CommunityPointAwardDecision | undefined> {
    return this.db.query.communityPointAwardDecisions.findFirst({
      where: eq(communityPointAwardDecisions.id, id),
    });
  }

  async findBySourceRule(
    sourceType: CommunityPointAwardDecision['sourceType'],
    sourceRef: string,
    ruleId: string,
  ): Promise<CommunityPointAwardDecision | undefined> {
    return this.db.query.communityPointAwardDecisions.findFirst({
      where: and(
        eq(communityPointAwardDecisions.sourceType, sourceType),
        eq(communityPointAwardDecisions.sourceRef, sourceRef),
        eq(communityPointAwardDecisions.ruleId, ruleId),
      ),
    });
  }

  async createIdempotent(
    input: NewCommunityPointAwardDecision,
  ): Promise<{ decision: CommunityPointAwardDecision; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(communityPointAwardDecisions)
      .values(input)
      .onConflictDoNothing({
        target: [
          communityPointAwardDecisions.sourceType,
          communityPointAwardDecisions.sourceRef,
          communityPointAwardDecisions.ruleId,
        ],
      })
      .returning();

    if (inserted) return { decision: inserted, inserted: true };

    const existing = await this.findBySourceRule(input.sourceType, input.sourceRef, input.ruleId);
    if (!existing) {
      throw new Error(
        'Community Point award decision conflict did not resolve to an existing row',
      );
    }
    return { decision: existing, inserted: false };
  }

  async updateOutcome(
    id: string,
    patch: Partial<
      Pick<
        NewCommunityPointAwardDecision,
        'accountId' | 'status' | 'points' | 'reasonCode' | 'evaluatedAt' | 'awardedTransactionId'
      >
    >,
  ): Promise<CommunityPointAwardDecision | undefined> {
    const [row] = await this.db
      .update(communityPointAwardDecisions)
      .set(patch)
      .where(eq(communityPointAwardDecisions.id, id))
      .returning();
    return row;
  }

  async listBySourceRef(
    sourceType: CommunityPointAwardDecision['sourceType'],
    sourceRef: string,
  ): Promise<CommunityPointAwardDecision[]> {
    return this.db.query.communityPointAwardDecisions.findMany({
      where: and(
        eq(communityPointAwardDecisions.sourceType, sourceType),
        eq(communityPointAwardDecisions.sourceRef, sourceRef),
      ),
      orderBy: [desc(communityPointAwardDecisions.evaluatedAt)],
    });
  }

  async listPendingMembershipForCustomer(
    customerId: string,
  ): Promise<CommunityPointAwardDecision[]> {
    return this.db.query.communityPointAwardDecisions.findMany({
      where: and(
        eq(communityPointAwardDecisions.customerId, customerId),
        eq(communityPointAwardDecisions.status, 'pending_membership'),
      ),
      orderBy: [desc(communityPointAwardDecisions.evaluatedAt)],
    });
  }
}
