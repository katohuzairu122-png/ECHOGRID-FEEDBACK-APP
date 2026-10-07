import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { communityPointRules } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CommunityPointRule = typeof communityPointRules.$inferSelect;
export type NewCommunityPointRule = typeof communityPointRules.$inferInsert;

export class CommunityPointRuleRepository extends BaseRepository {
  async findById(id: string): Promise<CommunityPointRule | undefined> {
    return this.db.query.communityPointRules.findFirst({
      where: eq(communityPointRules.id, id),
    });
  }

  async create(input: NewCommunityPointRule): Promise<CommunityPointRule> {
    const [row] = await this.db.insert(communityPointRules).values(input).returning();
    if (!row) throw new Error('Community Point rule insert returned no row');
    return row;
  }

  async listAll(): Promise<CommunityPointRule[]> {
    return this.db.query.communityPointRules.findMany({
      orderBy: [desc(communityPointRules.createdAt)],
    });
  }

  async findLatestVersion(
    sourceType: CommunityPointRule['sourceType'],
    resourceType: CommunityPointRule['resourceType'],
    resourceId: string | null,
  ): Promise<CommunityPointRule | undefined> {
    return this.db.query.communityPointRules.findFirst({
      where: and(
        eq(communityPointRules.sourceType, sourceType),
        resourceType === null
          ? isNull(communityPointRules.resourceType)
          : eq(communityPointRules.resourceType, resourceType),
        resourceId === null
          ? isNull(communityPointRules.resourceId)
          : eq(communityPointRules.resourceId, resourceId),
      ),
      orderBy: [desc(communityPointRules.version)],
    });
  }

  async findActiveForResource(
    sourceType: CommunityPointRule['sourceType'],
    resourceType: CommunityPointRule['resourceType'],
    resourceId: string | null,
    now = new Date(),
  ): Promise<CommunityPointRule | undefined> {
    return this.db.query.communityPointRules.findFirst({
      where: and(
        eq(communityPointRules.sourceType, sourceType),
        eq(communityPointRules.status, 'active'),
        resourceType === null
          ? isNull(communityPointRules.resourceType)
          : eq(communityPointRules.resourceType, resourceType),
        resourceId === null
          ? isNull(communityPointRules.resourceId)
          : eq(communityPointRules.resourceId, resourceId),
        or(isNull(communityPointRules.startsAt), lte(communityPointRules.startsAt, now)),
        or(isNull(communityPointRules.endsAt), gt(communityPointRules.endsAt, now)),
      ),
      orderBy: [desc(communityPointRules.version)],
    });
  }

  async isActiveNow(id: string, now = new Date()): Promise<CommunityPointRule | undefined> {
    return this.db.query.communityPointRules.findFirst({
      where: and(
        eq(communityPointRules.id, id),
        eq(communityPointRules.status, 'active'),
        or(isNull(communityPointRules.startsAt), lte(communityPointRules.startsAt, now)),
        or(isNull(communityPointRules.endsAt), gt(communityPointRules.endsAt, now)),
      ),
    });
  }

  async updateLifecycle(
    id: string,
    patch: Partial<
      Pick<NewCommunityPointRule, 'status' | 'activatedAt' | 'retiredAt'>
    >,
  ): Promise<CommunityPointRule | undefined> {
    const [row] = await this.db
      .update(communityPointRules)
      .set(patch)
      .where(eq(communityPointRules.id, id))
      .returning();
    return row;
  }
}
