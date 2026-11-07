import { describe, expect, it } from 'vitest';
import { createDevelopmentObservationCorrelationHarness } from './development-observation-correlation';

describe('DEV-26 private test-only correlation harness', () => {
  it('keeps unrelated attempts isolated with opaque symbols', () => {
    const harness = createDevelopmentObservationCorrelationHarness(2);
    const first = harness.begin();
    const second = harness.begin();
    expect(first).not.toBe(second);
    expect(harness.append(first, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1 }).status).toBe('UNCERTAIN');
    expect(harness.append(second, { outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: 0 }).status).toBe('NOT_RECORDED');
    expect(harness.append(first, { outcome: 'ACKNOWLEDGED', visibleRecords: 2 }).status).toBe('DUPLICATE_OBSERVED');
    expect(harness.classify(second).status).toBe('NOT_RECORDED');
  });
  it('enforces bounded capacity and releases tokens on end', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    expect(() => harness.begin()).toThrow('DEV26_CORRELATION_CAPACITY_REACHED');
    harness.end(token);
    expect(() => harness.classify(token)).toThrow('DEV26_CORRELATION_UNKNOWN');
    expect(typeof harness.begin()).toBe('symbol');
  });
  it('rejects invalid metadata and preserves sequence after failure', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    expect(() => harness.append(token, { outcome: 'ACKNOWLEDGED', visibleRecords: 0 })).toThrow();
    expect(() => harness.classify(token)).toThrow('DEV26_ATTEMPTS_INVALID');
    expect(harness.append(token, { outcome: 'ACKNOWLEDGED', visibleRecords: 1 }).financialAuthorization).toBe('NOT_GRANTED');
    expect(() => harness.append(token, { outcome: 'ACKNOWLEDGED', visibleRecords: 2, businessId: 'secret' } as never)).toThrow();
    expect(harness.classify(token).status).toBe('OBSERVED');
  });
  it('rejects foreign tokens and invalid capacities', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    expect(() => harness.append(Symbol(), { outcome: 'ACKNOWLEDGED', visibleRecords: 1 })).toThrow('DEV26_CORRELATION_UNKNOWN');
    expect(() => createDevelopmentObservationCorrelationHarness(0)).toThrow();
    expect(() => createDevelopmentObservationCorrelationHarness(1001)).toThrow();
  });
  it('never claims financial authorization, durable proof or exactly once', () => {
    const harness = createDevelopmentObservationCorrelationHarness(1);
    const token = harness.begin();
    const result = harness.append(token, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1 });
    expect(result).toMatchObject({ financialAuthorization: 'NOT_GRANTED', durableProof: false, exactlyOnce: false });
  });
});
