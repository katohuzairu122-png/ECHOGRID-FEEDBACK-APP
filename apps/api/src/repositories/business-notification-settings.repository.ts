import { eq } from 'drizzle-orm';
import { businessNotificationSettings } from '../db/schema';
import { BaseRepository } from './base.repository';

export type BusinessNotificationSettings = typeof businessNotificationSettings.$inferSelect;
export type NewBusinessNotificationSettings = typeof businessNotificationSettings.$inferInsert;

/** Mirrors LoyaltySettingsRepository exactly -- lazy get-or-create so every
 * business has a consistent row without a migration backfill. */
export class BusinessNotificationSettingsRepository extends BaseRepository {
  async findByBusiness(businessId: string): Promise<BusinessNotificationSettings | undefined> {
    return this.db.query.businessNotificationSettings.findFirst({
      where: eq(businessNotificationSettings.businessId, businessId),
    });
  }

  async getOrCreateDefaults(businessId: string): Promise<BusinessNotificationSettings> {
    const existing = await this.findByBusiness(businessId);
    if (existing) return existing;

    const [row] = await this.db
      .insert(businessNotificationSettings)
      .values({ businessId })
      .returning();
    return row;
  }

  async update(
    businessId: string,
    patch: Partial<Pick<NewBusinessNotificationSettings, 'emailEnabled' | 'smsEnabled' | 'maxSmsPerDay'>>,
    updatedBy: string,
  ): Promise<BusinessNotificationSettings> {
    await this.getOrCreateDefaults(businessId);
    const [row] = await this.db
      .update(businessNotificationSettings)
      .set({ ...patch, updatedBy, updatedAt: new Date() })
      .where(eq(businessNotificationSettings.businessId, businessId))
      .returning();
    return row;
  }
}
