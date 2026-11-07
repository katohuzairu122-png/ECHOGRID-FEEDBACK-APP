import { isPlatformJob } from './platform-job-validation';
import type { PlatformJob } from '../config/env';

/** Only fixed discriminants and validation results may enter failure logs. */
export function describeQueueFailure(body: unknown, attempts: unknown): {
  jobType: PlatformJob['type'] | 'unknown';
  payloadValid: boolean;
  attempt: number | null;
  errorCode: 'QUEUE_JOB_PAYLOAD_INVALID' | 'QUEUE_JOB_PROCESSING_FAILED';
} {
  const type = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).type : undefined;
  const jobType = type === 'classify_feedback' || type === 'generate_summary' ||
    type === 'send_notification' || type === 'escalate_critical_incident' ? type : 'unknown';
  const payloadValid = isPlatformJob(body);
  return {
    jobType,
    payloadValid,
    attempt: typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : null,
    errorCode: payloadValid ? 'QUEUE_JOB_PROCESSING_FAILED' : 'QUEUE_JOB_PAYLOAD_INVALID',
  };
}
