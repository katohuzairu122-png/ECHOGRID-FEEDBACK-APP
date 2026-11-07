import { describe, expect, it } from 'vitest';
import { describeQueueFailure } from './queue-failure-metadata';

describe('DEV-47 queue failure telemetry', () => {
  it.each([null, [], {}, { type: 'private_customer_token' }, { type: '<secret>' }])('bounds malformed payload metadata %#', body => {
    expect(describeQueueFailure(body, 1)).toEqual({ jobType: 'unknown', payloadValid: false, attempt: 1, errorCode: 'QUEUE_JOB_PAYLOAD_INVALID' });
  });
  it('uses full DEV-46 validation for known types', () => {
    expect(describeQueueFailure({ type: 'send_notification', recipientAddress: 'secret@example.com' }, 2)).toEqual({ jobType: 'send_notification', payloadValid: false, attempt: 2, errorCode: 'QUEUE_JOB_PAYLOAD_INVALID' });
  });
  it('omits sensitive fields from valid jobs', () => {
    const body = { type: 'send_notification', businessId: 'private', eventType: 'summary_ready', channel: 'email', recipientAddress: 'secret@example.com', body: 'secret' };
    expect(describeQueueFailure(body, 3)).toEqual({ jobType: 'send_notification', payloadValid: true, attempt: 3, errorCode: 'QUEUE_JOB_PROCESSING_FAILED' });
  });
  it.each([-1, 1.5, '3', Infinity, NaN, null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid attempts %#', attempt => {
    expect(describeQueueFailure(null, attempt).attempt).toBeNull();
  });
});
