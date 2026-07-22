import type { Repositories } from '../repositories';
import type { NotificationPreference } from '../repositories/notification-preference.repository';
import {
  DELIVERABLE_NOTIFICATION_CHANNELS,
  type NotificationEventType,
} from '@echo-grid-feedback/shared-types';
import { AuthorizationService } from '../rbac/authorization.service';
import { renderNotification, type NotificationTemplateData } from './notification-templates';
import { enqueueNotification, type SendNotificationJob } from './notification-job';

export interface NotifyRecipient {
  userId?: string;
  customerId?: string;
}

function startOfTodayUtc(): Date {
  // UTC midnight, not the business's own local midnight -- this cap is an
  // infra cost safety valve (see business-notification-settings.ts), not a
  // precise product feature, and this platform has no per-business
  // timezone field to key off yet (only branches.timezone exists). Revisit
  // if a real business ever notices their cap resetting at a UTC boundary
  // that doesn't match their local day.
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Orchestrates "should this recipient be notified, and how" (Notifications
 * Block 3) -- the decision layer that sits in front of
 * NotificationDeliveryService (Block 2, purely mechanical send+log). Checks,
 * in order: does the recipient have an address for this channel, is the
 * channel enabled business-wide, has the business's daily SMS cap been hit,
 * has the recipient explicitly opted out of this event+channel. Every skip
 * is silent and expected, not an error -- only a genuine enqueue failure
 * (queue unavailable) propagates, and even then per-channel, not
 * all-or-nothing (an email failure shouldn't prevent an SMS attempt).
 */
export class NotificationService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      | 'notificationPreferences'
      | 'notifications'
      | 'businessNotificationSettings'
      | 'users'
      | 'customers'
      | 'userBusinessRoles'
      | 'permissions'
    >,
    private readonly queue: Queue<SendNotificationJob>,
  ) {}

  async notify(businessId: string, recipient: NotifyRecipient, data: NotificationTemplateData): Promise<void> {
    if (!recipient.userId && !recipient.customerId) {
      throw new Error('notify() requires exactly one of userId/customerId.');
    }

    const rendered = renderNotification(data);
    const settings = await this.repos.businessNotificationSettings.getOrCreateDefaults(businessId);
    const address = await this.resolveAddress(recipient);

    for (const channel of DELIVERABLE_NOTIFICATION_CHANNELS) {
      const recipientAddress = channel === 'email' ? address.email : address.phone;
      if (!recipientAddress) continue; // recipient has no address for this channel

      if (channel === 'email' && !settings.emailEnabled) continue;
      if (channel === 'sms' && !settings.smsEnabled) continue;

      if (channel === 'sms') {
        const sentToday = await this.repos.notifications.countSince(businessId, 'sms', startOfTodayUtc());
        if (sentToday >= settings.maxSmsPerDay) continue; // cost cap reached
      }

      const preference = await this.repos.notificationPreferences.findOne(
        businessId,
        recipient,
        data.eventType,
        channel,
      );
      if (preference && !preference.enabled) continue; // explicit opt-out; no row = default enabled

      try {
        await enqueueNotification(this.queue, {
          businessId,
          userId: recipient.userId,
          customerId: recipient.customerId,
          eventType: data.eventType,
          channel,
          recipientAddress,
          subject: channel === 'email' ? rendered.subject : undefined,
          body: channel === 'email' ? rendered.emailHtml : rendered.smsText,
        });
      } catch (err) {
        // One channel's enqueue failing shouldn't prevent the other from
        // being attempted -- log and move on, don't let this method throw
        // and potentially roll back or fail the caller's own operation
        // (e.g. a purchase that already succeeded).
        console.error('Failed to enqueue notification:', {
          businessId,
          eventType: data.eventType,
          channel,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  }

  /**
   * Broadcasts one event to every active staff member at a business.
   * `requiredPermission`, if given, narrows to staff holding that key
   * (e.g. 'analytics:view' for summary_ready, since Staff doesn't hold it
   * by default) -- omit it for events every role should hear about
   * (feedback_received, redemption_pending are both held by every default
   * role today, so filtering would be a no-op for them).
   */
  async notifyBusinessStaff(
    businessId: string,
    data: NotificationTemplateData,
    requiredPermission?: string,
  ): Promise<void> {
    const grants = await this.repos.userBusinessRoles.listForBusiness(businessId);
    const uniqueUserIds = [...new Set(grants.map((g) => g.userId))];
    const authorization = new AuthorizationService(this.repos);

    for (const userId of uniqueUserIds) {
      if (requiredPermission) {
        const permissions = await authorization.getEffectivePermissions(userId, businessId);
        if (!permissions.has(requiredPermission)) continue;
      }
      await this.notify(businessId, { userId }, data);
    }
  }

  /**
   * Materializes the FULL (eventType x channel) grid for a settings screen
   * -- every combination gets a row, `enabled` reflecting either an
   * explicit preference or the default (true, see
   * notification-preferences.ts's schema comment), never just whichever
   * rows happen to exist in the DB. This keeps default-filling logic in one
   * place instead of every frontend caller re-deriving "no row = enabled."
   * `eventTypes` is the caller's responsibility (STAFF_NOTIFICATION_EVENT_TYPES
   * or CUSTOMER_NOTIFICATION_EVENT_TYPES from shared-types) so a staff
   * settings screen never shows a customer-only toggle or vice versa.
   */
  async listMaterializedPreferences(
    businessId: string,
    recipient: NotifyRecipient,
    eventTypes: readonly NotificationEventType[],
  ): Promise<Array<Pick<NotificationPreference, 'eventType' | 'channel' | 'enabled'>>> {
    const existing = await this.repos.notificationPreferences.listForRecipient(businessId, recipient);
    const existingByKey = new Map(existing.map((p) => [`${p.eventType}:${p.channel}`, p]));

    const result: Array<Pick<NotificationPreference, 'eventType' | 'channel' | 'enabled'>> = [];
    for (const eventType of eventTypes) {
      for (const channel of DELIVERABLE_NOTIFICATION_CHANNELS) {
        const found = existingByKey.get(`${eventType}:${channel}`);
        result.push({ eventType, channel, enabled: found?.enabled ?? true });
      }
    }
    return result;
  }

  private async resolveAddress(recipient: NotifyRecipient): Promise<{ email?: string | undefined; phone?: string | undefined }> {
    if (recipient.userId) {
      const user = await this.repos.users.findById(recipient.userId);
      return { email: user?.email, phone: user?.phone ?? undefined };
    }
    if (recipient.customerId) {
      const customer = await this.repos.customers.findById(recipient.customerId);
      return { email: customer?.email ?? undefined, phone: customer?.phone };
    }
    return {};
  }
}
