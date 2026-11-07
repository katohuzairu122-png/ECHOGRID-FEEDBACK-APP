import type { Database } from '../../db/client';
import type { VerifiedCustodyReader } from './custody-settlement-classification';
import type { WorkloadConfigSource, WorkloadEnvironment } from './workload-identity';
import { durableProvenanceResult, type DurableProvenanceResult } from './durable-provenance-result';
import { createPrivateProvenanceAuditStage, type ProvenanceAuditStage } from './private-provenance-audit-stage';

/**
 * DEV-23: an internal, bounded observation boundary for the genuine DEV-22
 * verification stage. Observations are NOT cryptographic attestations, do not
 * prove durable storage, and never grant financial authority.
 *
 * No tenant ID, reservation, authorization ID, payload, signature, workload
 * identity, credential, or provider reference may enter the observer.
 */
export type PrivateProvenanceObservation = Readonly<{
  event: 'PRIVATE_PROVENANCE_VERIFICATION';
  status: DurableProvenanceResult['status'];
  financialAuthorization: 'NOT_GRANTED';
}>;

export interface PrivateProvenanceObservationSink {
  record(event: PrivateProvenanceObservation): Promise<void>;
}

/** Deliberately refuses to claim an audit trail without an authorized sink. */
export function createUnprovisionedProvenanceObservationSink(): PrivateProvenanceObservationSink {
  return Object.freeze({
    record: async (_event: PrivateProvenanceObservation): Promise<void> => {
      throw new Error('PROVENANCE_OBSERVATION_SINK_UNPROVISIONED');
    },
  });
}

/**
 * Only constructs a wrapper over the actual private DEV-22 composition stage.
 * This does not accept a caller-created verification stage or status. It does
 * not mount a route, schedule, queue, DB role, or persistence adapter.
 *
 * A sink failure invalidates the returned status (including VERIFIED);
 * durability of any record remains the sink implementation's responsibility.
 * Operational sinks and their provisioning require separate owner approval.
 */
export function createObservedPrivateProvenanceAuditStage(deps: Readonly<{
  db: Database;
  custodyReader: VerifiedCustodyReader;
  source: WorkloadConfigSource | null | undefined;
  environment: WorkloadEnvironment;
  clock: () => number;
  recorderPublicKeys: Readonly<Record<string, string>>;
  sink: PrivateProvenanceObservationSink | null | undefined;
}>): ProvenanceAuditStage {
  const delegate = createPrivateProvenanceAuditStage(deps);
  return Object.freeze({
    async verify(request: Readonly<{
      businessId: string;
      reservationId: string;
      authorizationId: string;
    }>): Promise<DurableProvenanceResult> {
      let result: DurableProvenanceResult;
      try {
        result = await delegate.verify(request);
      } catch {
        result = durableProvenanceResult('UNAVAILABLE');
      }
      // The observation cannot carry any caller-chosen metadata.
      const event: PrivateProvenanceObservation = Object.freeze({
        event: 'PRIVATE_PROVENANCE_VERIFICATION',
        status: result.status,
        financialAuthorization: 'NOT_GRANTED',
      });
      try {
        if (!deps.sink || typeof deps.sink.record !== 'function')
          return durableProvenanceResult('UNAVAILABLE');
        await deps.sink.record(event);
      } catch {
        return durableProvenanceResult('UNAVAILABLE');
      }
      return result;
    },
  });
}
