import { describe, expect, it } from 'vitest';
import { createDevelopmentObservationCorrelationHarness } from './development-observation-correlation';
import { classifyDevelopmentObservationRetry, type ObservationAttempt } from './development-observation-retry-classification';

/** DEV-29: disposable, in-memory, test-only adversarial mutation and isolation checks. */
describe('DEV-29 correlation mutation and isolation invariants', () => {
  const lost: ObservationAttempt = { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0 };
  const acknowledged: ObservationAttempt = { outcome: 'ACKNOWLEDGED', visibleRecords: 1 };

  it('snapshots caller attempt values before later caller mutation', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    const attempt = { ...lost };
    expect(harness.append(token, attempt).status).toBe('UNCERTAIN');
    attempt.visibleRecords = 999;
    expect(harness.classify(token).status).toBe('UNCERTAIN');
    expect(harness.append(token, acknowledged).status).toBe('UNCERTAIN');
    harness.end(token);
  });

  it('isolates interleaved sequences and reuses capacity without reusing identity', () => {
    const harness = createDevelopmentObservationCorrelationHarness(2);
    const first = harness.begin();
    const second = harness.begin();
    expect(() => harness.begin()).toThrow('DEV26_CORRELATION_CAPACITY_REACHED');
    expect(harness.append(first, lost).status).toBe('UNCERTAIN');
    expect(harness.append(second, acknowledged).status).toBe('OBSERVED');
    expect(harness.classify(first).status).toBe('UNCERTAIN');
    expect(harness.classify(second).status).toBe('OBSERVED');
    harness.end(first);
    const third = harness.begin();
    expect(third).not.toBe(first);
    expect(() => harness.classify(first)).toThrow('DEV26_CORRELATION_UNKNOWN');
    expect(harness.append(third, { outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: 0 }).status).toBe('NOT_RECORDED');
    expect(harness.classify(second).status).toBe('OBSERVED');
    harness.end(second);
    harness.end(third);
  });

  it('does not mutate another sequence after an invalid append', () => {
    const harness = createDevelopmentObservationCorrelationHarness(2);
    const first = harness.begin();
    const second = harness.begin();
    harness.append(first, lost);
    harness.append(second, acknowledged);
    expect(() => harness.append(first, { outcome: 'ACKNOWLEDGED', visibleRecords: 0 })).toThrow('DEV26_CONTRADICTORY_ATTEMPT');
    expect(harness.classify(first).status).toBe('UNCERTAIN');
    expect(harness.classify(second).status).toBe('OBSERVED');
    harness.end(first);
    harness.end(second);
  });

  it('freezes returned classifications and never grants financial authority', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    const first = harness.append(token, acknowledged);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual({
      status: 'OBSERVED', financialAuthorization: 'NOT_GRANTED',
      durableProof: false, exactlyOnce: false,
    });
    expect(harness.classify(token)).toEqual(first);
    harness.end(token);
    const direct = classifyDevelopmentObservationRetry([lost]);
    expect(Object.isFrozen(direct)).toBe(true);
    expect(direct.financialAuthorization).toBe('NOT_GRANTED');
  });

  it('rejects a non-symbol token and preserves active capacity', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    expect(() => harness.end('external' as unknown as symbol)).toThrow('DEV26_CORRELATION_UNKNOWN');
    expect(() => harness.begin()).toThrow('DEV26_CORRELATION_CAPACITY_REACHED');
    expect(harness.append(token, lost).status).toBe('UNCERTAIN');
    harness.end(token);
    const replacement = harness.begin();
    expect(replacement).not.toBe(token);
    harness.end(replacement);
  });
});
