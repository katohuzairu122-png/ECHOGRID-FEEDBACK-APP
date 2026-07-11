import type { Repositories } from '../repositories';
import type { EmailService } from './email.service';
import type { SmsService } from '../customer-auth/sms.service';
import type { SendNotificationJob } from './notification-job';

/**
 * The queue consumer's actual work for a `send_notification` job (Block 2)
 * -- purely mechanical delivery + logging, no preference/cap decisions here
 * (those already happened in NotificationService before the job was
 * enqueued, see notification-job.ts's schema comment). Mirrors
 * SentimentService.classifyAndStore's write-then-attempt-then-resolve shape:
 * log a 'pending' row FIRST (so a Worker crash mid-send still leaves visible
 * evidence an attempt was made), attempt delivery, then mark sent/failed.
 *
 * Reuses SmsService directly (no notification-specific SMS wrapper) --
 * it was already a generic `send(toPhone, body)` interface with no
 * OTP-specific coupling, so extending it to a second caller needed no
 * changes at all.
 */
export class NotificationDeliveryService {
  constructor(
    private readonly repos: Pick<Repositories, 'notifications'>,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
  ) {}

  async deliver(job: SendNotificationJob): Promise<void> {
    const logRow = await this.repos.notifications.create({
      businessId: job.businessId,
      userId: job.userId ?? null,
      customerId: job.customerId ?? null,
      eventType: job.eventType,
      channel: job.channel,
      recipientAddress: job.recipientAddress,
      subject: job.subject ?? null,
      body: job.body,
      status: 'pending',
    });

    try {
      if (job.channel === 'email') {
        await this.emailService.send({
          to: job.recipientAddress,
          subject: job.subject ?? '',
          html: job.body,
        });
      } else if (job.channel === 'sms') {
        await this.smsService.send(job.recipientAddress, job.body);
      } else {
        // 'push' has no delivery implementation yet (see notification-job.ts)
        // -- reaching here means something enqueued a channel this service
        // doesn't support, a real bug, not a transient failure worth a retry.
        throw new Error(`Unsupported notification channel: ${job.channel}`);
      }
      await this.repos.notifications.markSent(logRow.id);
    } catch (err) {
      await this.repos.notifications.markFailed(logRow.id);
      throw err;
    }
  }
}
