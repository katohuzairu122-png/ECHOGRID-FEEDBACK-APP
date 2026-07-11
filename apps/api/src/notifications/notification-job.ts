import type { NotificationChannel, NotificationEventType } from '@echo-grid-feedback/shared-types';

/**
 * Message contract for the notification half of the `echo-grid-feedback-jobs`
 * queue (binding `JOBS`) -- mirrors sentiment-job.ts's shape exactly. The
 * job carries a FULLY RESOLVED send request (recipient address, rendered
 * subject/body already decided), not raw event data -- preference-checking,
 * business-notification-settings enforcement (kill switches, daily SMS cap),
 * and content rendering all happen in NotificationService (Block 3) BEFORE
 * enqueueing, not in the queue consumer. This keeps the job itself dumb,
 * same as ClassifyFeedbackJob/GenerateSummaryJob carrying resolved IDs
 * rather than business logic, and avoids a race where preferences change
 * between enqueue and delivery mattering (the decision was already made and
 * committed to at enqueue time).
 *
 * `channel` is typed against the full NotificationChannel union (includes
 * 'push') for forward-compatibility with shared-types, but
 * NotificationDeliveryService (Block 2) only implements 'email'/'sms' --
 * 'push' has no delivery implementation yet, so nothing enqueues it today.
 */
export interface SendNotificationJob {
  type: 'send_notification';
  businessId: string;
  userId?: string;
  customerId?: string;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  recipientAddress: string;
  /** Email only -- omitted for SMS, which has no subject line. */
  subject?: string;
  body: string;
}

/**
 * Enqueues one resolved notification send. Callers fire this via
 * `c.executionCtx.waitUntil` (or, for jobs originating inside the queue
 * consumer itself, awaited directly) so a slow/unavailable queue never
 * blocks the triggering request -- same "background work is best-effort,
 * layered on top of a response that already succeeded" principle as
 * sentiment-job.ts's enqueueClassification.
 */
export async function enqueueNotification(
  queue: Queue<SendNotificationJob>,
  input: Omit<SendNotificationJob, 'type'>,
): Promise<void> {
  await queue.send({ type: 'send_notification', ...input });
}
