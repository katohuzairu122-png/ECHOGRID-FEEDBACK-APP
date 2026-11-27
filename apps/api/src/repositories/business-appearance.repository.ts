import { eq } from 'drizzle-orm';
import { businessAppearance } from '../db/schema';
import { BaseRepository } from './base.repository';

export type BusinessAppearance = typeof businessAppearance.$inferSelect;

/** PROF-01: one lazy row per business. No row means no logo and no colour chosen yet. */
export class BusinessAppearanceRepository extends BaseRepository {
  async findByBusiness(businessId: string): Promise<BusinessAppearance | undefined> {
    return this.db.query.businessAppearance.findFirst({ where: eq(businessAppearance.businessId, businessId) });
  }

  /** Only the keys sent change; null clears one. Creates the row on first save. */
  async upsert(
    businessId: string,
    patch: { logoKey?: string | null | undefined; brandColorKey?: string | null | undefined },
    updatedBy: string,
  ): Promise<BusinessAppearance> {
    const values = {
      ...(patch.logoKey !== undefined ? { logoKey: patch.logoKey } : {}),
      ...(patch.brandColorKey !== undefined ? { brandColorKey: patch.brandColorKey } : {}),
    };
    const [row] = await this.db
      .insert(businessAppearance)
      .values({ businessId, ...values, updatedBy })
      .onConflictDoUpdate({ target: businessAppearance.businessId, set: { ...values, updatedAt: new Date(), updatedBy } })
      .returning();
    if (!row) throw new Error('Upsert returned no row');
    return row;
  }
}
