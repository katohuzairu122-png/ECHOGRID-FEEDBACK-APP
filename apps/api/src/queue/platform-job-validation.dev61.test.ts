import { describe, expect, it } from 'vitest';
import { isPlatformJob } from './platform-job-validation';
import { describeQueueFailure } from './queue-failure-metadata';
import { describeDeadLetterPayload } from './dead-letter-metadata';

const email = {
  type: 'send_notification' as const,
  businessId: 'business-a',
  eventType: 'summary_ready',
  channel: 'email',
  recipientAddress: 'staff@example.com',
  body: 'A private notification',
};

const validJobs = [
  { type: 'classify_feedback', feedbackId: 'feedback_1', businessId: 'business-a' },
  { type: 'generate_summary', businessId: 'business-a', branchId: 'branch_2',
    periodType: 'daily', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-11-02T00:00:00.000Z' },
  { ...email, userId: 'staff-1', customerId: undefined },
  { type: 'escalate_critical_incident', incidentId: 'incident-1', businessId: 'business-a' },
];

describe('DEV-61 queue IDs and notification destination integrity', () => {
  it.each(validJobs)('preserves known queue job contracts %#', job => {
    expect(isPlatformJob(job)).toBe(true);
  });

  it.each([
    '/private', '../business', 'some business', 'business.a', 'business,a',
    'business:a', 'user@example.com', '  staff', 'staff  ', 'a'.repeat(257),
    'a' + String.fromCharCode(0) + 'b',
    'a' + String.fromCharCode(10) + 'b',
    'a' + String.fromCharCode(13) + 'b',
    'a' + String.fromCharCode(127) + 'b',
    '', ' ',
  ])('denies untrusted queue identifiers %s across all four job variants', id => {
    for (const job of validJobs) {
      const overridden = { ...job, businessId: id };
      expect(isPlatformJob(overridden)).toBe(false);
    }
    expect(isPlatformJob({ ...validJobs[0], feedbackId: id })).toBe(false);
    expect(isPlatformJob({ ...validJobs[3], incidentId: id })).toBe(false);
    expect(isPlatformJob({ ...validJobs[1], branchId: id })).toBe(false);
    expect(isPlatformJob({ ...validJobs[2], userId: id })).toBe(false);
    expect(isPlatformJob({ ...validJobs[2], customerId: id })).toBe(false);
  });

  it.each([
    ' staff@example.com', 'staff@example.com ', 'user\t@example.com',
    'a' + String.fromCharCode(0) + '@example.com',
    'user' + String.fromCharCode(10) + '@example.com',
    'user' + String.fromCharCode(13) + '@example.com',
    'user' + String.fromCharCode(127) + '@example.com',
    'x'.repeat(2049),
    ' ', '',
  ])('rejects malformed notification recipient addresses %s', recipientAddress => {
    expect(isPlatformJob({ ...email, recipientAddress })).toBe(false);
  });

  it('preserves valid email and E.164-looking SMS addresses', () => {
    expect(isPlatformJob(email)).toBe(true);
    expect(isPlatformJob({ ...email, channel: 'sms', recipientAddress: '+15551234567' })).toBe(true);
  });

  it('excludes attacker-supplied queue body values from failure and DLQ telemetry', () => {
    const invalid = { ...email, businessId: '../secret-customer-token', recipientAddress: 'PII@example.com' };
    expect(isPlatformJob(invalid)).toBe(false);
    expect(describeQueueFailure(invalid, 2)).toEqual({
      jobType: 'send_notification',
      payloadValid: false,
      attempt: 2,
      errorCode: 'QUEUE_JOB_PAYLOAD_INVALID',
    });
    expect(describeDeadLetterPayload(invalid)).toEqual({ jobType: 'send_notification', payloadValid: false });
    const output = JSON.stringify({
      failure: describeQueueFailure(invalid, 2),
      deadLetter: describeDeadLetterPayload(invalid),
    });
    expect(output).not.toContain('secret-customer-token');
    expect(output).not.toContain('PII@example.com');
  });
});
