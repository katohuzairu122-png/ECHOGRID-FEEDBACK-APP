import { describe, expect, it } from 'vitest';
import { createDevelopmentObservationCorrelationHarness } from './development-observation-correlation';
import { classifyDevelopmentObservationRetry, type ObservationAttempt } from './development-observation-retry-classification';

/**
 * DEV-30: deterministic state-machine model checks on the disposable
 * correlation harness. This does not model persistence or authorization.
 */
describe('DEV-30 deterministic correlation state-machine regression', () => {
  const noRecord: ObservationAttempt = { outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: 0 };
  const lost: ObservationAttempt = { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0 };
  const acknowledged: ObservationAttempt = { outcome: 'ACKNOWLEDGED', visibleRecords: 1 };

  it('keeps all active tokens independent under deterministic interleaving and churn', () => {
    const harness = createDevelopmentObservationCorrelationHarness(3);
    const active = new Map<symbol, ObservationAttempt[]>();
    const stale: symbol[] = [];
    let seed = 0x30a5b29;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let step = 0; step < 600; step++) {
      const action = random() % 5;
      if ((action === 0 || active.size === 0) && active.size < 3) {
        const token = harness.begin();
        expect(active.has(token)).toBe(false);
        expect(stale.includes(token)).toBe(false);
        active.set(token, []);
      } else if (action === 1 && active.size > 0) {
        const tokens = [...active.keys()];
        const token = tokens[random() % tokens.length]!;
        harness.end(token);
        active.delete(token);
        stale.push(token);
        expect(() => harness.classify(token)).toThrow('DEV26_CORRELATION_UNKNOWN');
      } else if (active.size > 0) {
        const tokens = [...active.keys()];
        const token = tokens[random() % tokens.length]!;
        const history = active.get(token)!;
        const lastCount = history.length ? history[history.length - 1]!.visibleRecords : 0;
        const choice = random() % 3;
        const attempt: ObservationAttempt = choice === 0
          ? { outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: lastCount }
          : choice === 1
            ? { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: lastCount }
            : { outcome: 'ACKNOWLEDGED', visibleRecords: lastCount + 1 };
        history.push(attempt);
        const actual = harness.append(token, attempt);
        expect(actual).toEqual(classifyDevelopmentObservationRetry(history));
        expect(actual).toMatchObject({
          financialAuthorization: 'NOT_GRANTED', durableProof: false, exactlyOnce: false,
        });
      }
      for (const [token, history] of active) {
        if (history.length) expect(harness.classify(token)).toEqual(classifyDevelopmentObservationRetry(history));
        else expect(() => harness.classify(token)).toThrow('DEV26_ATTEMPTS_INVALID');
      }
      expect(active.size).toBeLessThanOrEqual(3);
      if (active.size === 3) expect(() => harness.begin()).toThrow('DEV26_CORRELATION_CAPACITY_REACHED');
    }
    for (const token of active.keys()) harness.end(token);
    for (const token of stale) expect(() => harness.classify(token)).toThrow('DEV26_CORRELATION_UNKNOWN');
  });

  it('does not consume capacity or mutate state on rejected operations', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    expect(harness.append(token, noRecord).status).toBe('NOT_RECORDED');
    expect(() => harness.append(token, { outcome: 'ACKNOWLEDGED', visibleRecords: 0 })).toThrow('DEV26_CONTRADICTORY_ATTEMPT');
    expect(() => harness.append(token, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: Number.NaN })).toThrow('DEV26_ATTEMPT_INVALID');
    expect(harness.classify(token).status).toBe('NOT_RECORDED');
    expect(harness.append(token, lost).status).toBe('UNCERTAIN');
    expect(harness.append(token, acknowledged).status).toBe('UNCERTAIN');
    harness.end(token);
    const fresh = harness.begin();
    expect(fresh).not.toBe(token);
    expect(() => harness.append(token, acknowledged)).toThrow('DEV26_CORRELATION_UNKNOWN');
    expect(harness.append(fresh, acknowledged).status).toBe('OBSERVED');
    harness.end(fresh);
  });
});
