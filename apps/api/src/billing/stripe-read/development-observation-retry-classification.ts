/**
 * DEV-26: disposable, test-only retry classification.
 *
 * Correlation is an in-process opaque handle, never a persisted identifier,
 * tenant identifier, audit attestation, or financial authorization. This
 * classifier deliberately cannot infer whether an unacknowledged append
 * committed. No runtime integration is permitted.
 */
export type ObservationAttempt = Readonly<{
  outcome: 'ACKNOWLEDGED' | 'REJECTED_BEFORE_RECORD' | 'ACKNOWLEDGEMENT_LOST';
  /** Number of records independently visible in the disposable test sink. */
  visibleRecords: number;
}>;

export type RetryClassification = Readonly<{
  status: 'NOT_RECORDED' | 'OBSERVED' | 'DUPLICATE_OBSERVED' | 'UNCERTAIN';
  financialAuthorization: 'NOT_GRANTED';
  durableProof: false;
  exactlyOnce: false;
}>;

export function classifyDevelopmentObservationRetry(
  attempts: readonly ObservationAttempt[],
): RetryClassification {
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 1000)
    throw new Error('DEV26_ATTEMPTS_INVALID');
  let priorCount = 0;
  let uncertain = false;
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt) ||
        Object.keys(attempt).length !== 2 ||
        !['ACKNOWLEDGED', 'REJECTED_BEFORE_RECORD', 'ACKNOWLEDGEMENT_LOST'].includes(attempt.outcome) ||
        !Number.isSafeInteger(attempt.visibleRecords) ||
        attempt.visibleRecords < priorCount || attempt.visibleRecords > 1000)
      throw new Error('DEV26_ATTEMPT_INVALID');
    if (attempt.outcome === 'REJECTED_BEFORE_RECORD' && attempt.visibleRecords !== priorCount)
      throw new Error('DEV26_CONTRADICTORY_ATTEMPT');
    if (attempt.outcome === 'ACKNOWLEDGED' && attempt.visibleRecords <= priorCount)
      throw new Error('DEV26_CONTRADICTORY_ATTEMPT');
    if (attempt.outcome === 'ACKNOWLEDGEMENT_LOST') uncertain = true;
    priorCount = attempt.visibleRecords;
  }
  const status: RetryClassification['status'] =
    priorCount > 1 ? 'DUPLICATE_OBSERVED' :
    uncertain ? 'UNCERTAIN' :
    priorCount === 1 ? 'OBSERVED' : 'NOT_RECORDED';
  return Object.freeze({
    status, financialAuthorization: 'NOT_GRANTED',
    durableProof: false, exactlyOnce: false,
  });
}
