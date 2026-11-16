import { eq, and, sql } from 'drizzle-orm';
import { branches } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { Patch } from '../lib/types';

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Every method requires businessId -- branches must never be looked up,
 * updated, or deleted across tenant boundaries.
 */
export class BranchRepository extends BaseRepository {
  async countActiveByBusiness(businessId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(branches)
      .where(and(eq(branches.businessId, businessId), eq(branches.isDeleted, false)));
    return row?.count ?? 0;
  }

  async findById(id: string, businessId: string): Promise<Branch | undefined> {
    return this.db.query.branches.findFirst({
      where: and(
        eq(branches.id, id),
        eq(branches.businessId, businessId),
        eq(branches.isDeleted, false),
      ),
    });
  }

  async findBySlug(businessId: string, slug: string): Promise<Branch | undefined> {
    return this.db.query.branches.findFirst({
      where: and(
        eq(branches.businessId, businessId),
        eq(branches.slug, slug),
        eq(branches.isDeleted, false),
      ),
    });
  }

  async listByBusiness(
    businessId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<Branch[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = options.offset ?? 0;
    return this.db.query.branches.findMany({
      where: and(eq(branches.businessId, businessId), eq(branches.isDeleted, false)),
      limit,
      offset,
      orderBy: (b, { desc }) => [desc(b.createdAt)],
    });
  }

  /** ONBOARDING-UX-01: conflict-safe insert; undefined when this business already has a branch with that slug. */
  async createIfSlugFree(input: NewBranch): Promise<Branch | undefined> {
    const [row] = await this.db
      .insert(branches)
      .values(input)
      .onConflictDoNothing({ target: [branches.businessId, branches.slug] })
      .returning();
    return row;
  }

  /** Serializes concurrent creations of the same branch name in one business (retry / double submit protection). */
  async lockCreation(businessId: string, name: string): Promise<void> {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`branch:${businessId}:${name.trim().toLowerCase()}`}, 0))`,
    );
  }

  /** A branch of the same name created in this business within the replay window by the same user, if any. */
  async findRecentByName(businessId: string, name: string, createdBy: string, windowSeconds: number): Promise<Branch | undefined> {
    const [row] = await this.db
      .select()
      .from(branches)
      .where(
        and(
          eq(branches.businessId, businessId),
          eq(branches.isDeleted, false),
          eq(branches.createdBy, createdBy),
          sql`lower(${branches.name}) = ${name.trim().toLowerCase()}`,
          sql`${branches.createdAt} > now() - make_interval(secs => ${windowSeconds})`,
        ),
      )
      .limit(1);
    return row;
  }

  async create(input: NewBranch): Promise<Branch> {
    const [row] = await this.db.insert(branches).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async update(
    id: string,
    businessId: string,
    patch: Patch<Omit<NewBranch, 'id' | 'businessId'>>,
    updatedBy: string,
  ): Promise<Branch | undefined> {
    const [row] = await this.db
      .update(branches)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(
        and(
          eq(branches.id, id),
          eq(branches.businessId, businessId),
          eq(branches.isDeleted, false),
        ),
      )
      .returning();
    return row;
  }

  async softDelete(id: string, businessId: string, deletedBy: string): Promise<void> {
    await this.db
      .update(branches)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
      .where(and(eq(branches.id, id), eq(branches.businessId, businessId)));
  }
}
