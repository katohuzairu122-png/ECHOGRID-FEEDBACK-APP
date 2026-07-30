import { eq } from 'drizzle-orm';
import { loyaltySettings } from '../db/schema';
import { BaseRepository } from './base.repository';

export type LoyaltySettings = typeof loyaltySettings.$inferSelect;
export type NewLoyaltySettings = typeof loyaltySettings.$inferInsert;

export class LoyaltySettingsRepository extends BaseRepository {
  async findByBusiness(businessId: string): Promise<LoyaltySettings | undefined> {
    return this.db.query.loyaltySettings.findFirst({
      where: eq(loyaltySettings.businessId, businessId),
    });
  }

  /** Lazily creates a defaults row on first access -- businesses created
   * before this table existed, or that never touched settings, still get a
   * consistent row instead of every caller special-casing "no settings yet". */
  async getOrCreateDefaults(businessId: string): Promise<LoyaltySettings> {
    const existing = await this.findByBusiness(businessId);
    if (existing) return existing;

    const [row] = await this.db.insert(loyaltySettings).values({ businessId }).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async update(
    businessId: string,
    patch: Partial<
      Pick<
        NewLoyaltySettings,
        'pointsPerCheckin' | 'pointsPerCurrencyUnit' | 'referralBonusPoints' | 'birthdayBonusPoints'
      >
    >,
    updatedBy: string,
  ): Promise<LoyaltySettings> {
    await this.getOrCreateDefaults(businessId);
    const [row] = await this.db
      .update(loyaltySettings)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(eq(loyaltySettings.businessId, businessId))
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }
}
