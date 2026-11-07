import { describe, expect, it } from 'vitest';
import { classifyDevelopmentObservationRetry, type ObservationAttempt } from './development-observation-retry-classification';
import { createDevelopmentObservationCorrelationHarness } from './development-observation-correlation';

/**
 * DEV-28: deterministic boundary/property-style tests only. No production
 * writer, storage, provider, authorization, or network access.
 */
describe('DEV-28 retry classification boundary invariants', () => {
  const outcomes = ['ACKNOWLEDGED', 'REJECTED_BEFORE_RECORD', 'ACKNOWLEDGEMENT_LOST'] as const;
  const expectedStatus = (attempts: readonly ObservationAttempt[]) => {
    const count = attempts.at(-1)!.visibleRecords;
    return count > 1 ? 'DUPLICATE_OBSERVED' :
      attempts.some(a => a.outcome === 'ACKNOWLEDGEMENT_LOST') ? 'UNCERTAIN' :
      count === 1 ? 'OBSERVED' : 'NOT_RECORDED';
  };

  it('exhaustively enumerates valid two-attempt synthetic histories', () => {
    let checked = 0;
    for (const first of outcomes) for (const second of outcomes)
      for (let firstCount = 0; firstCount <= 2; firstCount++)
        for (let secondCount = firstCount; secondCount <= 3; secondCount++) {
          if (first === 'REJECTED_BEFORE_RECORD' && firstCount !== 0) continue;
          if (first === 'ACKNOWLEDGED' && firstCount === 0) continue;
          if (second === 'REJECTED_BEFORE_RECORD' && secondCount !== firstCount) continue;
          if (second === 'ACKNOWLEDGED' && secondCount <= firstCount) continue;
          const attempts: ObservationAttempt[] = [
            { outcome: first, visibleRecords: firstCount },
            { outcome: second, visibleRecords: secondCount },
          ];
          const result = classifyDevelopmentObservationRetry(attempts);
          expect(result.status).toBe(expectedStatus(attempts));
          expect(result).toMatchObject({
            financialAuthorization: 'NOT_GRANTED', durableProof: false, exactlyOnce: false,
          });
          expect(Object.isFrozen(result)).toBe(true);
          checked++;
        }
    expect(checked).toBeGreaterThan(10);
  });

  it('rejects contradictory counts, malformed metadata and unsafe numbers', () => {
    const valid: ObservationAttempt = { outcome: 'ACKNOWLEDGED', visibleRecords: 1 };
    const invalid: unknown[] = [
      { outcome: 'ACKNOWLEDGED', visibleRecords: 0 },
      { outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: 1 },
      { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: -1 },
      { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1.5 },
      { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: Number.MAX_SAFE_INTEGER + 1 },
      { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: Number.NaN },
      { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1001 },
      { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1, businessId: 'forbidden' },
      null,
    ];
    for (const attempt of invalid)
      expect(() => classifyDevelopmentObservationRetry([attempt as ObservationAttempt])).toThrow();
    expect(() => classifyDevelopmentObservationRetry([valid, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0 }])).toThrow();
  });

  it('enforces maximum attempt count without claiming durability', () => {
    const history: ObservationAttempt[] = Array.from({ length: 1000 }, () => ({
      outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0,
    }));
    expect(classifyDevelopmentObservationRetry(history)).toMatchObject({
      status: 'UNCERTAIN', financialAuthorization: 'NOT_GRANTED', durableProof: false, exactlyOnce: false,
    });
    expect(() => classifyDevelopmentObservationRetry([...history, history[0]!])).toThrow('DEV26_ATTEMPTS_INVALID');
  });

  it('never mutates a correlation sequence after invalid or overflow attempts', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    for (let i = 0; i < 1000; i++) {
      const result = harness.append(token, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0 });
      expect(result.financialAuthorization).toBe('NOT_GRANTED');
    }
    expect(() => harness.append(token, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0 })).toThrow('DEV26_ATTEMPTS_INVALID');
    expect(harness.classify(token).status).toBe('UNCERTAIN');
    expect(() => harness.append(token, { outcome: 'ACKNOWLEDGED', visibleRecords: 0 })).toThrow();
    expect(harness.classify(token).status).toBe('UNCERTAIN');
    harness.end(token);
  });

  it('rejects invalid capacities and stale or foreign tokens', () => {
    for (const capacity of [-1, 0, 1.2, 1001, Number.NaN, Infinity])
      expect(() => createDevelopmentObservationCorrelationHarness(capacity)).toThrow('DEV26_CORRELATION_CAPACITY_INVALID');
    const first = createDevelopmentObservationCorrelationHarness(1);
    const second = createDevelopmentObservationCorrelationHarness(1);
    const token = first.begin();
    expect(() => second.classify(token)).toThrow('DEV26_CORRELATION_UNKNOWN');
    first.end(token);
    expect(() => first.append(token, { outcome: 'ACKNOWLEDGED', visibleRecords: 1 })).toThrow('DEV26_CORRELATION_UNKNOWN');
  });
});
