import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../repositories';
import type { EmailService } from './email.service';
import type { SmsService } from '../customer-auth/sms.service';
import type { SendNotificationJob } from './notification-job';
import { NotificationDeliveryService } from './notification-delivery.service';

/**
 * DEV-55 records actual at-least-once notification delivery semantics.
 * These fakes never contact Resend, Twilio or a database. They deliberately
 * do not assert exactly-once delivery: no durable job-level dedupe key or
 * idempotent provider acknowledgment is currently implemented.
 */
const emailJob: SendNotificationJob = {
  type: 'send_notification',
  businessId: 'business-a',
  userId: 'staff-a',
  eventType: 'summary_ready',
  channel: 'email',
  recipientAddress: 'private@example.test',
  subject: 'Summary ready',
  body: 'private notification body',
};

function harness() {
  const order: string[] = [];
  let logSerial = 0;
  const create = vi.fn(async () => {
    order.push('pending');
    logSerial += 1;
    return { id: `log-${logSerial}` };
  });
  const markSent = vi.fn(async () => {
    order.push('sent');
    return undefined;
  });
  const markFailed = vi.fn(async () => {
    order.push('failed');
    return undefined;
  });
  const sendEmail = vi.fn(async () => { order.push('email'); });
  const sendSms = vi.fn(async () => { order.push('sms'); });
  const notifications = { create, markSent, markFailed } as unknown as Repositories['notifications'];
  const email = { send: sendEmail } satisfies EmailService;
  const sms = { send: sendSms } satisfies SmsService;
  const service = new NotificationDeliveryService({ notifications }, email, sms);
  return { service, order, create, markSent, markFailed, sendEmail, sendSms };
}

describe('DEV-55 notification delivery operational integrity regressions', () => {
  it('persists a pending email attempt before calling the provider, then marks it sent', async () => {
    const h = harness();
    await h.service.deliver(emailJob);
    expect(h.order).toEqual(['pending', 'email', 'sent']);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'business-a',
      userId: 'staff-a',
      channel: 'email',
      status: 'pending',
    }));
    expect(h.markSent).toHaveBeenCalledWith('log-1');
    expect(h.markFailed).not.toHaveBeenCalled();
  });

  it('uses the same pending → send → sent sequence for SMS without touching email', async () => {
    const h = harness();
    await h.service.deliver({
      ...emailJob, channel: 'sms', recipientAddress: '+15555550123',
    });
    expect(h.order).toEqual(['pending', 'sms', 'sent']);
    expect(h.sendSms).toHaveBeenCalledWith('+15555550123', emailJob.body);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('marks a failed provider attempt and propagates failure for the queue retry path', async () => {
    const h = harness();
    h.sendEmail.mockImplementationOnce(async () => { h.order.push('email'); throw new Error('provider unavailable'); });
    await expect(h.service.deliver(emailJob)).rejects.toThrow('provider unavailable');
    expect(h.order).toEqual(['pending', 'email', 'failed']);
    expect(h.markFailed).toHaveBeenCalledWith('log-1');
    expect(h.markSent).not.toHaveBeenCalled();
  });

  it('does not call any provider when the pending record cannot be created', async () => {
    const h = harness();
    h.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(h.service.deliver(emailJob)).rejects.toThrow('database unavailable');
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.sendSms).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(h.markFailed).not.toHaveBeenCalled();
  });

  it('exposes the existing ambiguous send-then-status-write failure without claiming deduplication', async () => {
    const h = harness();
    h.markSent.mockImplementationOnce(async () => { h.order.push('sent'); throw new Error('markSent failed after provider success'); });
    await expect(h.service.deliver(emailJob)).rejects.toThrow('markSent failed after provider success');
    expect(h.order).toEqual(['pending', 'email', 'sent', 'failed']);
    expect(h.sendEmail).toHaveBeenCalledOnce();
    expect(h.markFailed).toHaveBeenCalledWith('log-1');
  });

  it('documents current at-least-once redelivery: identical jobs produce separate sends and logs', async () => {
    const h = harness();
    await h.service.deliver(emailJob);
    await h.service.deliver(emailJob);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
    expect(h.markSent).toHaveBeenNthCalledWith(1, 'log-1');
    expect(h.markSent).toHaveBeenNthCalledWith(2, 'log-2');
    expect(h.markFailed).not.toHaveBeenCalled();
  });
});
