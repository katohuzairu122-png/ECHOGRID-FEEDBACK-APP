import { describe, expect, it } from 'vitest';
import type { PrivateProvenanceObservation } from './private-provenance-observation';
import { createDevelopmentBoundedProvenanceObservationSink } from './development-bounded-provenance-observation-sink';

const event: PrivateProvenanceObservation = {
  event: 'PRIVATE_PROVENANCE_VERIFICATION',
  status: 'VERIFIED',
  financialAuthorization: 'NOT_GRANTED',
};

describe('DEV-24 disposable bounded provenance observer', () => {
  it('rejects absent, fractional, negative, and excessive capacity', () => {
    for (const capacity of [0, -1, 0.5, Number.NaN, Infinity, 1001]) {
      expect(() => createDevelopmentBoundedProvenanceObservationSink(capacity)).toThrow(
        'DEV24_OBSERVATION_CAPACITY_INVALID',
      );
    }
  });

  it('stores only immutable, schema-exact, nonfinancial observations', async () => {
    const sink = createDevelopmentBoundedProvenanceObservationSink(2);
    await sink.record(event);
    const snapshot = sink.snapshot();
    expect(snapshot).toEqual([event]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.keys(snapshot[0]!)).toEqual(['event', 'status', 'financialAuthorization']);
    expect(snapshot[0]!.financialAuthorization).toBe('NOT_GRANTED');
  });

  it('fails closed when full and never silently drops or overwrites an event', async () => {
    const sink = createDevelopmentBoundedProvenanceObservationSink(1);
    await sink.record(event);
    await expect(sink.record({ ...event, status: 'UNAVAILABLE' }))
      .rejects.toThrow('DEV24_OBSERVATION_CAPACITY_REACHED');
    expect(sink.snapshot()).toEqual([event]);
  });

  it('rejects injected identifiers, unsupported statuses, extra fields, and financial claims', async () => {
    const sink = createDevelopmentBoundedProvenanceObservationSink(2);
    const invalid: unknown[] = [
      { ...event, businessId: '11111111-1111-4111-8111-111111111111' },
      { ...event, status: 'AUTHORIZED' },
      { ...event, financialAuthorization: 'GRANTED' },
      { ...event, event: 'CUSTOM_EVENT' },
      null,
      [],
    ];
    for (const item of invalid) {
      await expect(sink.record(item as PrivateProvenanceObservation))
        .rejects.toThrow('DEV24_OBSERVATION_INVALID');
    }
    expect(sink.snapshot()).toEqual([]);
  });

  it('clones accepted objects to prevent changes in the caller from altering snapshots', async () => {
    const sink = createDevelopmentBoundedProvenanceObservationSink(2);
    const supplied = { ...event };
    await sink.record(supplied);
    supplied.status = 'INVALID';
    expect(sink.snapshot()).toEqual([event]);
  });

  it('serializes concurrent appends without capacity overrun', async () => {
    const sink = createDevelopmentBoundedProvenanceObservationSink(1);
    const results = await Promise.allSettled([sink.record(event), sink.record(event)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(sink.snapshot()).toHaveLength(1);
  });
});
