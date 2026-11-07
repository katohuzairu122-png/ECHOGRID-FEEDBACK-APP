import { describeDeadLetterPayload } from './dead-letter-metadata';

/**
 * Bounded, low-cardinality queue failure metadata.
 * Do not log raw message bodies, recipient details, exception strings or tenant IDs.
 */
export function describeQueueFailure(body: unknown, attempts: unknown, error: unknown): {
  jobType: string;
  payloadValid: boolean;
  attempt: number | null;
  errorCode: string;
} {
  const metadata = describeDeadLetterPayload(body);
  const attempt = typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts >= 0
    ? attempts : null;
  const errorCode = error instanceof Error && error.message === 'QUEUE_JOB_PAYLOAD_INVALID'
    ? 'QUEUE_JOB_PAYLOAD_INVALID' : 'QUEUE_JOB_PROCESSING_FAILED';
  return { ...metadata, attempt, errorCode };
}
