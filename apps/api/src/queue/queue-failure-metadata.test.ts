import { describe, expect, it } from 'vitest';
import { describeQueueFailure } from './queue-failure-metadata';

describe('DEV-47 bounded queue failure telemetry', () => {
  it('classifies malformed input without logging payloads', () => {
    expect(describeQueueFailure(null, 1, new Error('QUEUE_JOB_PAYLOAD_INVALID'))).toEqual({
      jobType:'unknown', payloadValid:false, attempt:1, errorCode:'QUEUE_JOB_PAYLOAD_INVALID',
    });
  });
  it('never includes provider error text, PII or arbitrary payload fields', () => {
    const result=describeQueueFailure(
      {type:'send_notification',recipientAddress:'private@example.com',body:'secret'},
      3,new Error('Stripe secret sk_test_private'),
    );
    expect(result).toEqual({jobType:'send_notification',payloadValid:true,attempt:3,errorCode:'QUEUE_JOB_PROCESSING_FAILED'});
    expect(JSON.stringify(result)).not.toMatch(/private|secret|Stripe/);
  });
  it.each([-1, 1.5, '3', Infinity, null])('does not trust invalid attempt count %#', attempt => {
    expect(describeQueueFailure({},attempt,'error').attempt).toBeNull();
  });
});
