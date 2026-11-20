import { eq, and, or, ilike, sql } from 'drizzle-orm';
import { businesses, qrCodes } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { Patch } from '../lib/types';

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

  /** CASHIER-AUTH-02A (D-3): resolves the public cashier sign-in code to its business. The code identifies, it never authorizes. */
  async findByCashierCode(cashierCode: string): Promise<Business | undefined> {
    return this.db.query.businesses.findFirst({
      where: and(eq(businesses.cashierCode, cashierCode), eq(businesses.isDeleted, false)),
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
    options: { search?: string | undefined; status?: BusinessStatus | undefined; limit?: number | undefined; offset?: number | undefined } = {},
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

  /**
   * LANDING-ROLE-01: the names a prospective loyalty customer may pick from. NAME ONLY (no id, slug, address, owner or contact), for
   * businesses that are active, not deleted and already have an active loyalty QR code (their name is shown on that QR page anyway).
   * Optional case-insensitive substring filter; the limit is capped so the public endpoint stays cheap.
   */
  async listNamesForCustomerDirectory(options: { search?: string | undefined; limit?: number | undefined } = {}): Promise<string[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    const term = options.search?.trim();
    const pattern = term ? `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : undefined;
    const rows = await this.db
      .selectDistinct({ name: businesses.name })
      .from(businesses)
      .innerJoin(qrCodes, eq(qrCodes.businessId, businesses.id))
      .where(
        and(
          eq(businesses.isDeleted, false),
          eq(businesses.status, 'active'),
          eq(qrCodes.status, 'active'),
          pattern ? ilike(businesses.name, pattern) : undefined,
        ),
      )
      .orderBy(businesses.name)
      .limit(limit);
    return rows.map((row) => row.name);
  }

  /**
   * ONBOARDING-UX-01: conflict-safe insert. Returns undefined when the slug is already taken (by ANY row, including a
   * soft-deleted one, because the unique index covers them) instead of raising a constraint error, so a concurrent
   * duplicate moves on to the next candidate and never aborts the surrounding transaction.
   */
  async createIfSlugFree(input: NewBusiness): Promise<Business | undefined> {
    const [row] = await this.db
      .insert(businesses)
      .values(input)
      .onConflictDoNothing({ target: businesses.slug })
      .returning();
    return row;
  }

  /** Serializes concurrent creations of the same name by the same owner (retry / double submit protection). */
  async lockCreation(ownerId: string, name: string): Promise<void> {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`business:${ownerId}:${name.trim().toLowerCase()}`}, 0))`,
    );
  }

  /** The same owner's business of the same name created within the replay window, if any. */
  async findRecentByOwnerAndName(ownerId: string, name: string, windowSeconds: number): Promise<Business | undefined> {
    const [row] = await this.db
      .select()
      .from(businesses)
      .where(
        and(
          eq(businesses.createdBy, ownerId),
          eq(businesses.isDeleted, false),
          sql`lower(${businesses.name}) = ${name.trim().toLowerCase()}`,
          sql`${businesses.createdAt} > now() - make_interval(secs => ${windowSeconds})`,
        ),
      )
      .limit(1);
    return row;
  }

  async create(input: NewBusiness): Promise<Business> {
    const [row] = await this.db.insert(businesses).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async update(
    id: string,
    patch: Patch<Omit<NewBusiness, 'id'>>,
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
