import { eq, and, gte, sql } from 'drizzle-orm';
import { notifications } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { NotificationChannel } from '@echo-grid-feedback/shared-types';

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Append-only send log -- see notifications.ts's schema comment. No
 * update-arbitrary-fields method on purpose, only the two status
 * transitions a delivery can actually make (markSent/markFailed). */
export class NotificationRepository extends BaseRepository {
  async create(input: NewNotification): Promise<Notification> {
    const [row] = await this.db.insert(notifications).values(input).returning();
    return row;
  }

  async markSent(id: string): Promise<Notification | undefined> {
    const [row] = await this.db
      .update(notifications)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(notifications.id, id))
      .returning();
    return row;
  }

  async markFailed(id: string): Promise<Notification | undefined> {
    const [row] = await this.db
      .update(notifications)
      .set({ status: 'failed' })
      .where(eq(notifications.id, id))
      .returning();
    return row;
  }

  async listForBusiness(
    businessId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Notification[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return this.db.query.notifications.findMany({
      where: eq(notifications.businessId, businessId),
      limit,
      offset: options.offset ?? 0,
      orderBy: (n, { desc }) => [desc(n.createdAt)],
    });
  }

  /**
   * Backs BusinessNotificationSettingsRepository's daily SMS cap check --
   * counts rows rather than maintaining a separate counter column, see
   * notifications.ts's schema comment for why that's an acceptable cost at
   * this cap's expected scale. `since` is the caller's responsibility
   * (typically "start of today in the business's own timezone" --
   * NotificationService, Block 3); this method takes a plain Date so it
   * stays timezone-agnostic and testable with a fake clock. Raw
   * `count(*)::int` via `sql`, matching FeedbackRepository.sentimentTrend's
   * established pattern in this codebase rather than drizzle-orm's `count()`
   * helper -- kept consistent with the one aggregate-query precedent already
   * proven here, since this code has no way to be executed before shipping
   * (sandbox unavailable all session).
   */
  async countSince(businessId: string, channel: NotificationChannel, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.businessId, businessId),
          eq(notifications.channel, channel),
          gte(notifications.createdAt, since),
        ),
      );
    return row?.value ?? 0;
  }
}
