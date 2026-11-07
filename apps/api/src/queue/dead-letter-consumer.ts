import type { Bindings, PlatformJob } from '../config/env';
import { notifyOps } from '../lib/ops-alert';
import { describeDeadLetterPayload } from './dead-letter-metadata';

/**
 * Dead-letter messages have already exhausted the main queue retry policy.
 * Record a bounded alert for each message, then acknowledge that message.
 * This preserves the existing deliberate discard-on-alert policy. The alert
 * helper logs unconditionally and treats webhook delivery as best-effort.
 *
 * Keep this path independent of database access so a database outage cannot
 * prevent dead-letter alerts. Exported separately from index.ts to test the
 * real acknowledgment ordering and mixed-batch behavior.
 */
export async function handleDeadLetterBatch(
  batch: MessageBatch<PlatformJob>,
  env: Bindings,
): Promise<void> {
  for (const message of batch.messages) {
    const metadata = describeDeadLetterPayload(message.body);
    await notifyOps(env, {
      event: 'queue.dead_letter',
      severity: 'critical',
      message: `A ${metadata.jobType} job exhausted its retries and was dead-lettered.`,
      detail: {
        messageId: message.id,
        jobType: metadata.jobType,
        attempts: message.attempts,
        payloadValid: metadata.payloadValid,
      },
    });
    message.ack();
  }
}
