import type { PlatformJob } from '../config/env';
import { isPlatformJob } from './platform-job-validation';

export interface DeadLetterPayloadMetadata {
  jobType: PlatformJob['type'] | 'unknown';
  payloadValid: boolean;
}

/**
 * Dead-letter payloads are untrusted, even when their type looks like a safe
 * identifier. Only known queue discriminants may reach operational alerts.
 * Shape validity must mean the full DEV-46 contract, not a regex match.
 * Never emit arbitrary body fields or free-text job types.
 */
export function describeDeadLetterPayload(body: unknown): DeadLetterPayloadMetadata {
  const type = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).type : undefined;
  const jobType = type === 'classify_feedback' || type === 'generate_summary' ||
    type === 'send_notification' || type === 'escalate_critical_incident' ? type : 'unknown';

  return { jobType, payloadValid: isPlatformJob(body) };
}
