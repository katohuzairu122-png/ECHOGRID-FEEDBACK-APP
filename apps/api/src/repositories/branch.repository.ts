import { eq, and } from 'drizzle-orm';
import { branches } from '../db/schema';
import { BaseRepository } from './base.repository';

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Every method requires businessId -- branches must never be looked up,
 * updated, or deleted across tenant boundaries.
 */
export class BranchRepository extends BaseRepository {
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
    options: { limit?: number; offset?: number } = {},
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

  async create(input: NewBranch): Promise<Branch> {
    const [row] = await this.db.insert(branches).values(input).returning();
    return row;
  }

  async update(
    id: string,
    businessId: string,
    patch: Partial<Omit<NewBranch, 'id' | 'businessId'>>,
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
