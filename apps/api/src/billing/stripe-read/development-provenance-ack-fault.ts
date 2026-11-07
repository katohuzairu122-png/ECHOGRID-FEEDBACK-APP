import type {
  PrivateProvenanceObservation,
  PrivateProvenanceObservationSink,
} from './private-provenance-observation';

/**
 * DEV-25 — deterministic, test-only acknowledgement uncertainty.
 *
 * This fault adapter is NOT a durable queue, audit trail, retry service,
 * delivery confirmation, or production component. No routes or runtime wiring.
 *
 * BEFORE: the downstream record is not attempted.
 * AFTER: downstream record resolves, then the acknowledgement is lost.
 * A caller must regard both as UNAVAILABLE. It cannot infer from a thrown
 * error whether the downstream record exists.
 */
export type DevelopmentObservationFault = 'NONE' | 'BEFORE_RECORD' | 'AFTER_RECORD';

export interface DevelopmentFaultControlledObservationSink
  extends PrivateProvenanceObservationSink {
  setNextFault(fault: DevelopmentObservationFault): void;
}

const validFault = (value: unknown): value is DevelopmentObservationFault =>
  value === 'NONE' || value === 'BEFORE_RECORD' || value === 'AFTER_RECORD';

/**
 * The sink is injected by a disposable test harness. No global registry
 * or persistence exists. The fault is one-shot and reset before any await,
 * preventing overlapping asynchronous calls from consuming the same fault.
 */
export function createDevelopmentObservationAcknowledgementFaultSink(
  downstream: PrivateProvenanceObservationSink,
): DevelopmentFaultControlledObservationSink {
  if (!downstream || typeof downstream.record !== 'function')
    throw new Error('DEV25_OBSERVATION_DOWNSTREAM_INVALID');

  let nextFault: DevelopmentObservationFault = 'NONE';
  return Object.freeze({
    setNextFault(fault: DevelopmentObservationFault): void {
      if (!validFault(fault))
        throw new Error('DEV25_OBSERVATION_FAULT_INVALID');
      nextFault = fault;
    },
    async record(event: PrivateProvenanceObservation): Promise<void> {
      const fault = nextFault;
      nextFault = 'NONE';
      if (fault === 'BEFORE_RECORD')
        throw new Error('DEV25_OBSERVATION_ACK_UNAVAILABLE');
      await downstream.record(event);
      if (fault === 'AFTER_RECORD')
        throw new Error('DEV25_OBSERVATION_ACK_UNAVAILABLE');
    },
  });
}
