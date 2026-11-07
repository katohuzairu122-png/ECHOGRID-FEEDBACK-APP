import { describe, expect, it } from 'vitest';
import { classifyDevelopmentObservationRetry, type ObservationAttempt } from './development-observation-retry-classification';
import { createDevelopmentObservationCorrelationHarness } from './development-observation-correlation';

/**
 * DEV-31: synthetic metamorphic properties for the test-only classifier.
 * This deliberately does not infer durable delivery, settlement or authority.
 */
describe('DEV-31 retry classifier metamorphic invariants', () => {
  const reject = (count: number): ObservationAttempt => ({
    outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: count,
  });
  const lost = (count: number): ObservationAttempt => ({
    outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: count,
  });
  const ack = (count: number): ObservationAttempt => ({
    outcome: 'ACKNOWLEDGED', visibleRecords: count,
  });
  const verifyDenial = (attempts: ObservationAttempt[]) => {
    const result = classifyDevelopmentObservationRetry(attempts);
    expect(result).toMatchObject({
      financialAuthorization: 'NOT_GRANTED', durableProof: false, exactlyOnce: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    return result;
  };

  it('repeating a rejected no-record attempt preserves classification', () => {
    const histories: ObservationAttempt[][] = [
      [reject(0)], [ack(1)], [lost(0)], [ack(1), lost(1)],
      [ack(1), ack(2)], [lost(0), ack(1), ack(2)],
    ];
    for (const history of histories) {
      const prior = verifyDenial(history);
      const last = history[history.length - 1]!;
      const extended = verifyDenial([...history, reject(last.visibleRecords)]);
      expect(extended).toEqual(prior);
    }
  });

  it('once uncertainty is observed it remains unless duplicate status dominates', () => {
    for (let count = 0; count <= 2; count++) {
      const history: ObservationAttempt[] = count === 0
        ? [lost(0)] : count === 1 ? [ack(1), lost(1)] : [ack(1), ack(2), lost(2)];
      for (const extension of [reject(count), lost(count), ack(count + 1)]) {
        const result = verifyDenial([...history, extension]);
        expect(result.status).toBe(count > 1 || extension.visibleRecords > 1
          ? 'DUPLICATE_OBSERVED' : 'UNCERTAIN');
      }
    }
  });

  it('duplicate observation status is absorbing for valid extensions', () => {
    const base: ObservationAttempt[] = [ack(1), ack(2)];
    for (const extension of [reject(2), lost(2), ack(3)]) {
      expect(verifyDenial([...base, extension]).status).toBe('DUPLICATE_OBSERVED');
    }
  });

  it('classifies an appended history consistently with the disposable harness', () => {
    const histories: ObservationAttempt[][] = [
      [reject(0), lost(0), ack(1)],
      [ack(1), reject(1), lost(1)],
      [lost(0), ack(1), ack(2)],
      [reject(0), reject(0), ack(1)],
    ];
    for (const history of histories) {
      const harness = createDevelopmentObservationCorrelationHarness(1);
      const token = harness.begin();
      for (let i = 0; i < history.length; i++) {
        const prefix = history.slice(0, i + 1);
        expect(harness.append(token, history[i] as ObservationAttempt)).toEqual(verifyDenial(prefix));
      }
      expect(harness.classify(token)).toEqual(verifyDenial(history));
      harness.end(token);
    }
  });

  it('does not mutate caller-owned history and refuses extra metadata', () => {
    const history: ObservationAttempt[] = [ack(1)];
    const before = JSON.stringify(history);
    verifyDenial(history);
    expect(JSON.stringify(history)).toBe(before);
    expect(() => classifyDevelopmentObservationRetry([
      { outcome: 'ACKNOWLEDGED', visibleRecords: 1, tenantId: 'not-allowed' } as ObservationAttempt,
    ])).toThrow('DEV26_ATTEMPT_INVALID');
  });
});
