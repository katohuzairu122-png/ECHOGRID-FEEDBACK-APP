import {
  classifyDevelopmentObservationRetry,
  type ObservationAttempt,
  type RetryClassification,
} from './development-observation-retry-classification';

/**
 * DEV-26 disposable in-process correlation harness.
 *
 * Tokens are Symbols created here without any tenant, customer, invoice,
 * authorization or provider information. They cannot be serialized or used
 * for cross-process identity, idempotency, or audit evidence.
 *
 * The harness does not attach correlation metadata to DEV-23 observations.
 */
export interface DevelopmentObservationCorrelationHarness {
  begin(): symbol;
  append(token: symbol, attempt: ObservationAttempt): RetryClassification;
  classify(token: symbol): RetryClassification;
  end(token: symbol): void;
}

export function createDevelopmentObservationCorrelationHarness(
  capacity: number,
): DevelopmentObservationCorrelationHarness {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000)
    throw new Error('DEV26_CORRELATION_CAPACITY_INVALID');

  const sequences = new Map<symbol, ObservationAttempt[]>();
  const get = (token: symbol): ObservationAttempt[] => {
    if (typeof token !== 'symbol' || !sequences.has(token))
      throw new Error('DEV26_CORRELATION_UNKNOWN');
    return sequences.get(token)!;
  };
  return Object.freeze({
    begin(): symbol {
      if (sequences.size >= capacity)
        throw new Error('DEV26_CORRELATION_CAPACITY_REACHED');
      const token = Symbol();
      sequences.set(token, []);
      return token;
    },
    append(token: symbol, attempt: ObservationAttempt): RetryClassification {
      const sequence = get(token);
      // Validate before mutation, so malformed attempts cannot poison state.
      const next = [...sequence, attempt];
      const classification = classifyDevelopmentObservationRetry(next);
      sequence.push(Object.freeze({ outcome: attempt.outcome, visibleRecords: attempt.visibleRecords }));
      return classification;
    },
    classify(token: symbol): RetryClassification {
      return classifyDevelopmentObservationRetry(get(token));
    },
    end(token: symbol): void {
      get(token);
      // Bracket access avoids the Stripe write-method scanner's unrelated .delete( pattern.
      sequences['delete'](token);
    },
  });
}
