import { eq, and, or, ilike } from 'drizzle-orm';
import { businesses } from '../db/schema';
import { BaseRepository } from './base.repository';

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;

/**
 * businesses.status is a plain text column at the Drizzle level (no
 * .$type<>() narrowing, unlike users.platformRole) -- this literal union
 * exists purely at the application layer, mirroring the CHECK constraint's
 * value list (businesses_status_check), so callers of list()/the platform
 * directory's status filter get real narrowing instead of accepting any
 * string.
 */
export type BusinessStatus = 'active' | 'suspended' | 'archived';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class BusinessRepository extends BaseRepository {
  async findById(id: string): Promise<Business | undefined> {
    return this.db.query.businesses.findFirst({
      where: and(eq(businesses.id, id), eq(businesses.isDeleted, false)),
    });
  }

  /** Businesses are the tenant root, so slug is globally unique (see schema). */
  async findBySlug(slug: string): Promise<Business | undefined> {
    return this.db.query.businesses.findFirst({
      where: and(eq(businesses.slug, slug), eq(businesses.isDeleted, false)),
    });
  }

  /**
   * Already inherently cross-tenant (businesses IS the tenant root -- there
   * is no higher scope to filter by), so unlike most repositories here this
   * was never subject to BaseRepository's "never query across tenant
   * boundaries" convention. `search`/`status` are additive and optional
   * (Platform Admin Console Block 2's directory screen); every existing
   * caller -- the weekly/monthly summary cron in index.ts -- passes neither
   * and keeps seeing every business, unfiltered, exactly as before.
   */
  async list(
    options: { search?: string; status?: BusinessStatus; limit?: number; offset?: number } = {},
  ): Promise<Business[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = options.offset ?? 0;
    const searchPattern = options.search?.trim() ? `%${options.search.trim()}%` : undefined;
    return this.db.query.businesses.findMany({
      where: and(
        eq(businesses.isDeleted, false),
        options.status ? eq(businesses.status, options.status) : undefined,
        searchPattern
          ? or(ilike(businesses.name, searchPattern), ilike(businesses.slug, searchPattern))
          : undefined,
      ),
      limit,
      offset,
      orderBy: (b, { desc }) => [desc(b.createdAt)],
    });
  }

  async create(input: NewBusiness): Promise<Business> {
    const [row] = await this.db.insert(businesses).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<NewBusiness, 'id'>>,
    updatedBy: string,
  ): Promise<Business | undefined> {
    const [row] = await this.db
      .update(businesses)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(and(eq(businesses.id, id), eq(businesses.isDeleted, false)))
      .returning();
    return row;
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    await this.db
      .update(businesses)
      .set({ isDeleted: true, deletedAt: new Date(), deletedBy })
      .where(eq(businesses.id, id));
  }
}
