import type { PrivateProvenanceObservation, PrivateProvenanceObservationSink } from './private-provenance-observation';

/**
 * DEV-24: disposable, private, in-memory observation sink for development tests.
 *
 * NOT durable evidence, NOT a production adapter, NOT an authorization
 * mechanism. The bounded capacity is a hard failure, not a circular buffer:
 * a full sink must never silently discard an observation.
 */
export interface BoundedPrivateProvenanceObservationSink extends PrivateProvenanceObservationSink {
  /** Returns frozen, safe copies with no identifiers or payloads. */
  snapshot(): readonly PrivateProvenanceObservation[];
}

const allowedStatuses = new Set<PrivateProvenanceObservation['status']>([
  'VERIFIED', 'UNLINKED', 'INVALID', 'UNAVAILABLE',
]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function sanitize(event: unknown): PrivateProvenanceObservation {
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error('DEV24_OBSERVATION_INVALID');
  const fields = event as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 3 ||
      !['event', 'status', 'financialAuthorization'].every(key => own(fields, key)) ||
      fields.event !== 'PRIVATE_PROVENANCE_VERIFICATION' ||
      !allowedStatuses.has(fields.status as PrivateProvenanceObservation['status']) ||
      fields.financialAuthorization !== 'NOT_GRANTED')
    throw new Error('DEV24_OBSERVATION_INVALID');
  return Object.freeze({
    event: 'PRIVATE_PROVENANCE_VERIFICATION',
    status: fields.status as PrivateProvenanceObservation['status'],
    financialAuthorization: 'NOT_GRANTED',
  });
}

/**
 * This constructor is for disposable test harnesses only. No singleton or
 * runtime wiring exists. It cannot be substituted for a persisted audit log.
 */
export function createDevelopmentBoundedProvenanceObservationSink(
  capacity: number,
): BoundedPrivateProvenanceObservationSink {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000)
    throw new Error('DEV24_OBSERVATION_CAPACITY_INVALID');

  const observations: PrivateProvenanceObservation[] = [];
  return Object.freeze({
    async record(event: PrivateProvenanceObservation): Promise<void> {
      // Validate *before* capacity checks to ensure malformed input is never
      // accepted; no asynchronous gap exists in the single append operation.
      const accepted = sanitize(event);
      if (observations.length >= capacity)
        throw new Error('DEV24_OBSERVATION_CAPACITY_REACHED');
      observations.push(accepted);
    },
    snapshot(): readonly PrivateProvenanceObservation[] {
      return Object.freeze(observations.map(event => Object.freeze({ ...event })));
    },
  });
}
