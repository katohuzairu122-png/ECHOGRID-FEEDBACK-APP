import { describe, expect, it } from 'vitest';
import { createDevelopmentObservationCorrelationHarness } from './development-observation-correlation';
import { classifyDevelopmentObservationRetry, type ObservationAttempt } from './development-observation-retry-classification';

/** DEV-32: test-only bounded-history and capacity boundary verification. */
describe('DEV-32 bounded retry history and capacity invariants', () => {
  const rejected = (count: number): ObservationAttempt => ({
    outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: count,
  });
  const acknowledged = (count: number): ObservationAttempt => ({
    outcome: 'ACKNOWLEDGED', visibleRecords: count,
  });

  it('accepts exactly 1000 attempts but refuses a 1001st without poisoning a sequence', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    const attempts = Array.from({ length: 1000 }, () => rejected(0));
    for (const attempt of attempts) expect(harness.append(token, attempt).status).toBe('NOT_RECORDED');
    expect(harness.classify(token)).toEqual(classifyDevelopmentObservationRetry(attempts));
    expect(() => harness.append(token, rejected(0))).toThrow('DEV26_ATTEMPTS_INVALID');
    expect(harness.classify(token).status).toBe('NOT_RECORDED');
    harness.end(token);
    const fresh = harness.begin();
    expect(harness.append(fresh, acknowledged(1)).status).toBe('OBSERVED');
    harness.end(fresh);
  });

  it('enforces valid capacity boundaries without allocating tokens', () => {
    for (const invalid of [0, -1, 1.5, 1001, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => createDevelopmentObservationCorrelationHarness(invalid)).toThrow('DEV26_CORRELATION_CAPACITY_INVALID');
    }
    for (const capacity of [1, 2, 1000]) {
      const harness = createDevelopmentObservationCorrelationHarness(capacity);
      const tokens = Array.from({ length: capacity }, () => harness.begin());
      expect(new Set(tokens).size).toBe(capacity);
      expect(() => harness.begin()).toThrow('DEV26_CORRELATION_CAPACITY_REACHED');
      for (const token of tokens) harness.end(token);
      const fresh = harness.begin();
      expect(tokens).not.toContain(fresh);
      harness.end(fresh);
    }
  });

  it('rejects invalid visible-record boundaries without mutating valid history', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    expect(harness.append(token, acknowledged(1)).status).toBe('OBSERVED');
    for (const invalid of [-1, 1.5, NaN, Infinity, 1001, Number.MAX_SAFE_INTEGER]) {
      expect(() => harness.append(token, rejected(invalid))).toThrow('DEV26_ATTEMPT_INVALID');
      expect(harness.classify(token).status).toBe('OBSERVED');
    }
    expect(() => harness.append(token, rejected(0))).toThrow('DEV26_ATTEMPT_INVALID'.replace('ATTEMPT_INVALID', 'CONTRADICTORY_ATTEMPT'));
    expect(harness.classify(token).status).toBe('OBSERVED');
    harness.end(token);
  });

  it('preserves explicit denial of authority at maximum visible record count', () => {
    const history: ObservationAttempt[] = [acknowledged(1000), rejected(1000)];
    const result = classifyDevelopmentObservationRetry(history);
    expect(result).toEqual({
      status: 'DUPLICATE_OBSERVED', financialAuthorization: 'NOT_GRANTED',
      durableProof: false, exactlyOnce: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => classifyDevelopmentObservationRetry([acknowledged(1001)])).toThrow('DEV26_ATTEMPT_INVALID');
  });
});
