import { describe, expect, it } from 'vitest';
import { describeDeadLetterPayload } from './dead-letter-metadata';

describe('DEV-48 strict dead-letter queue metadata', () => {
  it.each([
    null, undefined, false, 4, 'text', [], {}, { type: 1 },
    { type: '<script>' }, { type: 'a'.repeat(100) },
    { type: 'private_customer_token' }, { type: 'secret_api_key' },
  ])('does not expose unrecognized or malformed job types %#', body => {
    expect(describeDeadLetterPayload(body)).toEqual({ jobType: 'unknown', payloadValid: false });
  });

  it.each([
    { type: 'classify_feedback', feedbackId: 'f', businessId: 'b' },
    {
      type: 'generate_summary', businessId: 'b', periodType: 'daily',
      periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-02T00:00:00Z',
    },
    {
      type: 'send_notification', businessId: 'b', eventType: 'summary_ready',
      channel: 'email', recipientAddress: 'secret@example.com', body: 'private content',
    },
    { type: 'escalate_critical_incident', incidentId: 'i', businessId: 'b' },
  ])('recognizes a valid supported payload %#', body => {
    expect(describeDeadLetterPayload(body)).toEqual({ jobType: body.type, payloadValid: true });
  });

  it('retains the recognized type but rejects malformed known-type payloads', () => {
    expect(describeDeadLetterPayload({ type: 'send_notification', recipientAddress: 'secret@example.com' }))
      .toEqual({ jobType: 'send_notification', payloadValid: false });
    expect(describeDeadLetterPayload({ type: 'classify_feedback', feedbackId: 'f' }))
      .toEqual({ jobType: 'classify_feedback', payloadValid: false });
    expect(describeDeadLetterPayload({ type: 'classify_feedback', feedbackId: 'f', businessId: 'b', secret: 'do not log' }))
      .toEqual({ jobType: 'classify_feedback', payloadValid: false });
  });

  it('never copies recipient data, prose or arbitrary private properties into alerts', () => {
    const result = describeDeadLetterPayload({
      type: 'send_notification', businessId: 'b', eventType: 'summary_ready',
      channel: 'sms', recipientAddress: '+15551234567', body: 'private feedback',
      accessToken: 'private-secret',
    });
    expect(result).toEqual({ jobType: 'send_notification', payloadValid: false });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('15551234567');
  });
});
