import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, PlatformJob } from '../config/env';
import { notifyOps } from '../lib/ops-alert';
import { handleDeadLetterBatch } from './dead-letter-consumer';

vi.mock('../lib/ops-alert', () => ({ notifyOps: vi.fn() }));

const env = { ENVIRONMENT: 'development', OPS_ALERT_WEBHOOK_URL: undefined } as Bindings;

function makeMessage(id: string, body: unknown, attempts: number) {
  return {
    id, body, attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<PlatformJob>;
}

function batchOf(...messages: Message<PlatformJob>[]): MessageBatch<PlatformJob> {
  return { queue: 'echo-grid-feedback-jobs-dlq', messages } as unknown as MessageBatch<PlatformJob>;
}

describe('DEV-49 dead-letter acknowledgment and mixed-batch regression', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(notifyOps).mockResolvedValue(undefined);
  });

  it('alerts and acks every message individually, even if another payload is malformed', async () => {
    const valid = makeMessage('msg-1', { type: 'classify_feedback', feedbackId: 'f', businessId: 'b' }, 4);
    const malformed = makeMessage('msg-2', null, 4);
    const invalidKnown = makeMessage('msg-3', { type: 'send_notification', recipientAddress: 'secret@example.com' }, 4);
    await handleDeadLetterBatch(batchOf(valid, malformed, invalidKnown), env);

    expect(notifyOps).toHaveBeenCalledTimes(3);
    expect(vi.mocked(notifyOps).mock.calls.map(call => call[1].detail)).toEqual([
      { messageId: 'msg-1', jobType: 'classify_feedback', attempts: 4, payloadValid: true },
      { messageId: 'msg-2', jobType: 'unknown', attempts: 4, payloadValid: false },
      { messageId: 'msg-3', jobType: 'send_notification', attempts: 4, payloadValid: false },
    ]);
    for (const message of [valid, malformed, invalidKnown]) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls)).not.toContain('secret@example.com');
  });

  it('awaits the alert record before acknowledging the message', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(notifyOps).mockImplementationOnce(() => pending);
    const message = makeMessage('pending-1', { type: 'unexpected_personal_data' }, 4);
    const run = handleDeadLetterBatch(batchOf(message), env);

    expect(message.ack).not.toHaveBeenCalled();
    release();
    await run;
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('does not acknowledge when alert recording unexpectedly rejects', async () => {
    vi.mocked(notifyOps).mockRejectedValueOnce(new Error('internal alert failure'));
    const first = makeMessage('failed', {}, 4);
    const next = makeMessage('not-processed', null, 4);
    await expect(handleDeadLetterBatch(batchOf(first, next), env)).rejects.toThrow('internal alert failure');

    expect(first.ack).not.toHaveBeenCalled();
    expect(next.ack).not.toHaveBeenCalled();
    expect(first.retry).not.toHaveBeenCalled();
    expect(next.retry).not.toHaveBeenCalled();
  });

  it('emits only bounded metadata for an unrecognized job type', async () => {
    const message = makeMessage('msg-4', { type: 'private_customer_token', token: 'do-not-send' }, 4);
    await handleDeadLetterBatch(batchOf(message), env);
    expect(vi.mocked(notifyOps).mock.calls[0]?.[1]).toEqual({
      event: 'queue.dead_letter',
      severity: 'critical',
      message: 'A unknown job exhausted its retries and was dead-lettered.',
      detail: { messageId: 'msg-4', jobType: 'unknown', attempts: 4, payloadValid: false },
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls)).not.toContain('do-not-send');
  });
});
