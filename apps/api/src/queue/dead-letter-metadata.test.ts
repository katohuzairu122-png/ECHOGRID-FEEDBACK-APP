import { describe, expect, it } from 'vitest';
import { describeDeadLetterPayload } from './dead-letter-metadata';

describe('DEV-46 malformed DLQ metadata', () => {
  it.each([null, undefined, false, 4, 'text', [], {}, {type: 1}, {type:'<script>'}, {type:'a'.repeat(100)}])('safely describes invalid payload %#', body => {
    expect(describeDeadLetterPayload(body)).toEqual({jobType:'unknown',payloadValid:false});
  });
  it('returns a bounded type but never copies arbitrary payload fields', () => {
    expect(describeDeadLetterPayload({type:'send_notification',recipientAddress:'secret@example.com',body:'private'}))
      .toEqual({jobType:'send_notification',payloadValid:true});
  });
});
