import { describe, expect, it } from 'vitest';
import { createDevelopmentBoundedProvenanceObservationSink } from './development-bounded-provenance-observation-sink';
import { createDevelopmentObservationCorrelationHarness } from './development-observation-correlation';
import type { PrivateProvenanceObservation } from './private-provenance-observation';

/**
 * DEV-27: synthetic replay/fault matrix. The sink is disposable and never
 * claims durable storage. No production Stripe, DB or financial path.
 */
const event: PrivateProvenanceObservation = Object.freeze({
  event: 'PRIVATE_PROVENANCE_VERIFICATION',
  status: 'VERIFIED',
  financialAuthorization: 'NOT_GRANTED',
});

describe('DEV-27 synthetic observation retry fault matrix', () => {
  it.each([
    { label: 'before record', fault: 'BEFORE', first: 0, second: 1, firstOutcome: 'REJECTED_BEFORE_RECORD', expected: 'OBSERVED' },
    { label: 'after record', fault: 'AFTER', first: 1, second: 2, firstOutcome: 'ACKNOWLEDGEMENT_LOST', expected: 'DUPLICATE_OBSERVED' },
    { label: 'acknowledgement succeeds', fault: 'NONE', first: 1, second: 2, firstOutcome: 'ACKNOWLEDGED', expected: 'DUPLICATE_OBSERVED' },
  ] as const)('$label: status-only replay never grants financial authority', async ({ fault, first, second, firstOutcome, expected }) => {
    const sink = createDevelopmentBoundedProvenanceObservationSink(3);
    const correlation = createDevelopmentObservationCorrelationHarness(1);
    const token = correlation.begin();
    if (fault !== 'BEFORE') await sink.record(event);
    expect(sink.snapshot()).toHaveLength(first);
    correlation.append(token, { outcome: firstOutcome, visibleRecords: first });
    await sink.record(event);
    expect(sink.snapshot()).toHaveLength(second);
    const result = correlation.append(token, { outcome: 'ACKNOWLEDGED', visibleRecords: second });
    expect(result.status).toBe(expected);
    expect(result.financialAuthorization).toBe('NOT_GRANTED');
    expect(result.durableProof).toBe(false);
    expect(result.exactlyOnce).toBe(false);
    for (const observation of sink.snapshot()) {
      expect(Object.keys(observation).sort()).toEqual(['event', 'financialAuthorization', 'status']);
      expect(observation.financialAuthorization).toBe('NOT_GRANTED');
    }
    correlation.end(token);
    expect(() => correlation.classify(token)).toThrow('DEV26_CORRELATION_UNKNOWN');
  });

  it('ambiguous acknowledgement with no visible append remains uncertain', () => {
    const correlation = createDevelopmentObservationCorrelationHarness(1);
    const token = correlation.begin();
    const result = correlation.append(token, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 0 });
    expect(result).toMatchObject({ status: 'UNCERTAIN', financialAuthorization: 'NOT_GRANTED', durableProof: false, exactlyOnce: false });
  });

  it('full sink rejects retry without losing the earlier status-only observation', async () => {
    const sink = createDevelopmentBoundedProvenanceObservationSink(1);
    await sink.record(event);
    const correlation = createDevelopmentObservationCorrelationHarness(1);
    const token = correlation.begin();
    correlation.append(token, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: 1 });
    await expect(sink.record(event)).rejects.toThrow('DEV24_OBSERVATION_CAPACITY_REACHED');
    const result = correlation.append(token, { outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: 1 });
    expect(result.status).toBe('UNCERTAIN');
    expect(sink.snapshot()).toHaveLength(1);
  });

  it('independent synthetic sequences cannot observe each other', async () => {
    const sinkA = createDevelopmentBoundedProvenanceObservationSink(2);
    const sinkB = createDevelopmentBoundedProvenanceObservationSink(2);
    const correlation = createDevelopmentObservationCorrelationHarness(2);
    const a = correlation.begin();
    const b = correlation.begin();
    await sinkA.record(event);
    correlation.append(a, { outcome: 'ACKNOWLEDGEMENT_LOST', visibleRecords: sinkA.snapshot().length });
    correlation.append(b, { outcome: 'REJECTED_BEFORE_RECORD', visibleRecords: sinkB.snapshot().length });
    expect(correlation.classify(a).status).toBe('UNCERTAIN');
    expect(correlation.classify(b).status).toBe('NOT_RECORDED');
    expect(sinkB.snapshot()).toHaveLength(0);
  });
});
