/** Safe, bounded metadata for untrusted dead-letter queue payloads. */
export function describeDeadLetterPayload(body: unknown): { jobType: string; payloadValid: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { jobType: 'unknown', payloadValid: false };
  }
  const type = (body as Record<string, unknown>).type;
  if (typeof type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(type)) {
    return { jobType: 'unknown', payloadValid: false };
  }
  return { jobType: type, payloadValid: true };
}
