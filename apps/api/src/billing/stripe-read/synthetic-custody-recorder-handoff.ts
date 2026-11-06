import type { MockSettlementEvidence } from '../settlement-eligibility.classifier';
import type { VerifiedCustodyReader } from './custody-settlement-classification';
import { isIssuedCustodyReader } from './index';

/**
 * DEV-18 development-only handoff. NOT a production composition root.
 * No route, queue, cron or financial writer imports this module.
 * The injected reader MUST be the trusted DEV-15 custody boundary; the
 * structural port alone is not an authentication capability.
 *
 * This adapter never trusts an asserted verdict. The existing DEV-03
 * recorder independently loads persisted expectations, classifies evidence
 * under its own database clock, and signs its own authorization snapshot.
 */
export interface IndependentSettlementRecorder {
  record(input: { reservationId: string; businessId: string; evidence: MockSettlementEvidence }): Promise<{
    id: string;
    verdict: 'ELIGIBLE' | 'INELIGIBLE' | 'UNRESOLVED';
    reasonCodes: readonly string[];
    replay: boolean;
  }>;
}

export type CustodyRecorderResult =
  | Readonly<{ ok: true; evidenceId: string; authorizationId: string; verdict: 'ELIGIBLE' | 'INELIGIBLE' | 'UNRESOLVED'; replay: boolean; financialAuthorization: 'NOT_GRANTED' }>
  | Readonly<{ ok: false; reason: 'INVALID_REQUEST' | 'CUSTODY_NOT_TRUSTED' | 'CUSTODY_UNAVAILABLE' | 'CUSTODY_UNVERIFIED' | 'BINDING_MISMATCH' | 'RECORDER_UNAVAILABLE'; financialAuthorization: 'NOT_GRANTED' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deny = (reason: Extract<CustodyRecorderResult, { ok: false }>['reason']): CustodyRecorderResult =>
  ({ ok: false, reason, financialAuthorization: 'NOT_GRANTED' });
const has = (x: object, k: string) => Object.prototype.hasOwnProperty.call(x, k);

/**
 * This service has no runtime binding or exported production factory.
 * Only a trusted, isolated test/development composition root may supply
 * the custody and recorder capabilities. Never wire it to an API request.
 */
export function createSyntheticCustodyRecorderHandoff(deps: Readonly<{
  custody: VerifiedCustodyReader;
  recorder: IndependentSettlementRecorder;
}>): Readonly<{ record(request: { evidenceId: string; businessId: string; reservationId: string }): Promise<CustodyRecorderResult> }> {
  // The marker is held in a private WeakSet owned by the DEV-15 custody
  // service. A shape-compatible object or fake AUTHENTIC result is insufficient.
  // Check again at each call, and fail closed without invoking the recorder.
  return Object.freeze({
    async record(request: { evidenceId: string; businessId: string; reservationId: string }): Promise<CustodyRecorderResult> {
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).length !== 3 || !['evidenceId', 'businessId', 'reservationId'].every(k => has(request, k)) ||
        typeof request.evidenceId !== 'string' || !UUID.test(request.evidenceId) ||
        typeof request.businessId !== 'string' || !UUID.test(request.businessId) ||
        typeof request.reservationId !== 'string' || request.reservationId.length === 0 || request.reservationId.length > 255)
        return deny('INVALID_REQUEST');

      if (!isIssuedCustodyReader(deps.custody)) return deny('CUSTODY_NOT_TRUSTED');
      try {
        const custody = await deps.custody.retrieve({
          evidenceId: request.evidenceId, businessId: request.businessId,
          purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
        });
        if (!custody.ok) return deny('CUSTODY_UNAVAILABLE');
        if (custody.authenticity !== 'AUTHENTIC' || custody.financialAuthorization !== 'NOT_GRANTED' ||
          custody.claims.businessId !== request.businessId || custody.claims.environment !== 'development' ||
          custody.claims.purpose !== 'SYNTHETIC_TEST_EVIDENCE' || custody.claims.evidenceType !== 'SYNTHETIC_TEST_EVIDENCE')
          return deny('CUSTODY_UNVERIFIED');

        const payload = custody.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || !has(payload, 'settlementEvidence'))
          return deny('BINDING_MISMATCH');
        const raw = payload.settlementEvidence;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          return deny('BINDING_MISMATCH');
        const evidence = raw as MockSettlementEvidence;
        if (evidence.binding?.businessId !== request.businessId ||
          evidence.binding.reservationId !== request.reservationId ||
          evidence.provenance?.evidenceKind !== 'MOCK_SYNTHETIC')
          return deny('BINDING_MISMATCH');

        // Intentionally passes facts, NOT an externally computed verdict.
        // The recorder locks the reservation and reclassifies against
        // trusted persisted invoice/allocation/subscription and DB time.
        let recorded;
        try {
          recorded = await deps.recorder.record({
            businessId: request.businessId, reservationId: request.reservationId, evidence,
          });
        } catch { return deny('RECORDER_UNAVAILABLE'); }
        if (!recorded || typeof recorded.id !== 'string' || !UUID.test(recorded.id) ||
          !['ELIGIBLE', 'INELIGIBLE', 'UNRESOLVED'].includes(recorded.verdict) ||
          typeof recorded.replay !== 'boolean')
          return deny('RECORDER_UNAVAILABLE');
        return {
          ok: true, evidenceId: request.evidenceId, authorizationId: recorded.id,
          verdict: recorded.verdict, replay: recorded.replay, financialAuthorization: 'NOT_GRANTED',
        };
      } catch {
        return deny('CUSTODY_UNAVAILABLE');
      }
    },
  });
}
