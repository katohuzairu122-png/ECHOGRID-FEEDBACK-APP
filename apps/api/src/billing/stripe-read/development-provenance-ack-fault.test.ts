import { describe, expect, it } from 'vitest';
import type { PrivateProvenanceObservation } from './private-provenance-observation';
import { createDevelopmentBoundedProvenanceObservationSink } from './development-bounded-provenance-observation-sink';
import { createDevelopmentObservationAcknowledgementFaultSink } from './development-provenance-ack-fault';

const event: PrivateProvenanceObservation = Object.freeze({
  event: 'PRIVATE_PROVENANCE_VERIFICATION',
  status: 'VERIFIED',
  financialAuthorization: 'NOT_GRANTED',
});

describe('DEV-25 observation acknowledgement uncertainty (test-only)', () => {
  it('refuses missing downstream before accepting an observation', () => {
    expect(() => createDevelopmentObservationAcknowledgementFaultSink(
      null as never,
    )).toThrow('DEV25_OBSERVATION_DOWNSTREAM_INVALID');
  });

  it('BEFORE_RECORD rejects without an append and resets the fault', async () => {
    const storage = createDevelopmentBoundedProvenanceObservationSink(3);
    const faulty = createDevelopmentObservationAcknowledgementFaultSink(storage);
    faulty.setNextFault('BEFORE_RECORD');
    await expect(faulty.record(event)).rejects.toThrow('DEV25_OBSERVATION_ACK_UNAVAILABLE');
    expect(storage.snapshot()).toHaveLength(0);
    await faulty.record(event);
    expect(storage.snapshot()).toEqual([event]);
  });

  it('AFTER_RECORD rejects despite an append, so acknowledgement is not proof of absence', async () => {
    const storage = createDevelopmentBoundedProvenanceObservationSink(3);
    const faulty = createDevelopmentObservationAcknowledgementFaultSink(storage);
    faulty.setNextFault('AFTER_RECORD');
    await expect(faulty.record(event)).rejects.toThrow('DEV25_OBSERVATION_ACK_UNAVAILABLE');
    expect(storage.snapshot()).toEqual([event]);
    // The transport has no event identity or idempotency token. Retrying can
    // duplicate a status-only observation; DEV-25 must not claim exactly-once.
    await faulty.record(event);
    expect(storage.snapshot()).toEqual([event, event]);
  });

  it('rejects unrecognized fault mode before mutating the current plan', async () => {
    const storage = createDevelopmentBoundedProvenanceObservationSink(1);
    const faulty = createDevelopmentObservationAcknowledgementFaultSink(storage);
    faulty.setNextFault('BEFORE_RECORD');
    expect(() => faulty.setNextFault('FINANCIAL_GRANT' as never))
      .toThrow('DEV25_OBSERVATION_FAULT_INVALID');
    await expect(faulty.record(event)).rejects.toThrow('DEV25_OBSERVATION_ACK_UNAVAILABLE');
    expect(storage.snapshot()).toHaveLength(0);
  });

  it('one-shot fault is consumed before any await even under overlapping writes', async () => {
    const storage = createDevelopmentBoundedProvenanceObservationSink(3);
    const faulty = createDevelopmentObservationAcknowledgementFaultSink(storage);
    faulty.setNextFault('AFTER_RECORD');
    const results = await Promise.allSettled([faulty.record(event), faulty.record(event)]);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(storage.snapshot()).toEqual([event, event]);
    expect(storage.snapshot().every(v => v.financialAuthorization === 'NOT_GRANTED')).toBe(true);
  });
});
