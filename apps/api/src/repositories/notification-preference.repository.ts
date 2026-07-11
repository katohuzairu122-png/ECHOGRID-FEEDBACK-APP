import { eq, and, isNull } from 'drizzle-orm';
import { notificationPreferences } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { NotificationChannel, NotificationEventType } from '@echo-grid-feedback/shared-types';

export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;

export interface NotificationRecipient {
  userId?: string;
  customerId?: string;
}

export class NotificationPreferenceRepository extends BaseRepository {
  /** All preference rows a recipient has explicitly set at one business.
   * An event/channel pair with NO row here means "use the default"
   * (enabled=true, see notification-preferences.ts's schema comment) --
   * callers (NotificationService, Block 3) treat an absent row as enabled,
   * not as a row to be lazily materialized, so a recipient who never opens
   * the settings screen doesn't get thousands of default rows written. */
  async listForRecipient(
    businessId: string,
    recipient: NotificationRecipient,
  ): Promise<NotificationPreference[]> {
    return this.db.query.notificationPreferences.findMany({
      where: and(
        eq(notificationPreferences.businessId, businessId),
        recipient.userId
          ? eq(notificationPreferences.userId, recipient.userId)
          : isNull(notificationPreferences.userId),
        recipient.customerId
          ? eq(notificationPreferences.customerId, recipient.customerId)
          : isNull(notificationPreferences.customerId),
      ),
    });
  }

  async findOne(
    businessId: string,
    recipient: NotificationRecipient,
    eventType: NotificationEventType,
    channel: NotificationChannel,
  ): Promise<NotificationPreference | undefined> {
    return this.db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.businessId, businessId),
        recipient.userId
          ? eq(notificationPreferences.userId, recipient.userId)
          : isNull(notificationPreferences.userId),
        recipient.customerId
          ? eq(notificationPreferences.customerId, recipient.customerId)
          : isNull(notificationPreferences.customerId),
        eq(notificationPreferences.eventType, eventType),
        eq(notificationPreferences.channel, channel),
      ),
    });
  }

  /**
   * Explicit find-then-write, not `onConflictDoUpdate` against the partial
   * unique index -- Drizzle's `targetWhere` support for partial-index
   * upserts has multiple open, version-dependent bug reports upstream, and
   * this code has no way to be executed against a real Postgres instance
   * before shipping (sandbox unavailable all session). A rare
   * check-then-write race (two concurrent toggles of the exact same
   * preference) surfaces as a clear unique-constraint DB error rather than
   * silent data corruption -- acceptable for a low-frequency, user-initiated
   * settings toggle, unlike the loyalty points engine's transactional needs.
   */
  async setPreference(
    businessId: string,
    recipient: NotificationRecipient,
    eventType: NotificationEventType,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<NotificationPreference> {
    const existing = await this.findOne(businessId, recipient, eventType, channel);
    if (existing) {
      const [row] = await this.db
        .update(notificationPreferences)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(notificationPreferences.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await this.db
      .insert(notificationPreferences)
      .values({
        businessId,
        userId: recipient.userId ?? null,
        customerId: recipient.customerId ?? null,
        eventType,
        channel,
        enabled,
      })
      .returning();
    return row;
  }
}
