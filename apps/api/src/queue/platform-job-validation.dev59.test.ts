import { describe, expect, it } from 'vitest';
import { notificationEventTypeSchema } from '@echo-grid-feedback/shared-types';
import { isPlatformJob } from './platform-job-validation';

const base = {
  type: 'send_notification' as const,
  businessId: 'business-a',
  channel: 'email',
  recipientAddress: 'staff@example.com',
  body: 'Notification',
};

describe('DEV-59 notification queue event vocabulary', () => {
  it.each(notificationEventTypeSchema.options)(
    'accepts the shared contract event %s (with existing valid delivery fields)',
    (eventType) => {
      expect(isPlatformJob({ ...base, eventType })).toBe(true);
    },
  );

  it.each([
    'arbitrary_event', 'PAYMENT_APPROVED', 'summary_ready\nprivate',
    '  summary_ready', 'summary_ready ', 'critical_feedback_alert_extra',
    '', ' ', 'summary-ready', '__proto__',
  ])('rejects unknown or malformed event %s', eventType => {
    expect(isPlatformJob({ ...base, eventType })).toBe(false);
  });

  it.each([null, 0, true, {}, [], ['summary_ready']])(
    'rejects non-string event types %#', eventType => {
      expect(isPlatformJob({ ...base, eventType })).toBe(false);
    },
  );

  it('preserves the existing fail-closed unsupported push channel', () => {
    expect(isPlatformJob({ ...base, eventType: 'summary_ready', channel: 'push' })).toBe(false);
  });

  it('rejects extra arbitrary fields without confusing event validity', () => {
    expect(isPlatformJob({
      ...base, eventType: 'summary_ready', authenticationToken: 'do-not-log',
    })).toBe(false);
  });
});
