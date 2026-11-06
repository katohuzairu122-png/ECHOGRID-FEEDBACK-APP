import type { EvidenceVerifier, ExpectedEvidence } from './stripe-read/evidence-signing';
import {
  classifySettlement, type MockSettlementEvidence, type SettlementClassification,
  type SettlementClassifierContext,
} from './settlement-eligibility.classifier';

/**
 * DEV-16 isolated integration stage. Authenticity is not provider authority.
 * This stage is deliberately synthetic-only and has no recorder, database, Stripe,
 * consumption, or ledger capability. DEV-15 custody integration is a separate gate.
 */
export interface SignedEvidenceLookup {
  load(evidenceId: string): Promise<unknown | null>;
}

export type StagedSettlementResult =
  | Readonly<{ ok: true; classification: SettlementClassification; financialAuthorization: 'NOT_GRANTED' }>
  | Readonly<{ ok: false; reason: 'INVALID_REQUEST' | 'EVIDENCE_UNAVAILABLE' | 'SIGNATURE_UNVERIFIED' | 'BINDING_MISMATCH' | 'CLASSIFIER_UNRESOLVED'; financialAuthorization: 'NOT_GRANTED' }>;

const REFERENCE = /^[A-Za-z0-9_:./-]{1,128}$/;

/**
 * Only the existing cryptographic verifier may establish authenticity.
 * The signed payload remains MOCK_SYNTHETIC; even an ELIGIBLE classifier
 * outcome is not persisted, and cannot grant accounting authority.
 */
export function createSyntheticSettlementStage(deps: Readonly<{
  lookup: SignedEvidenceLookup;
  verifier: EvidenceVerifier;
  expected: ExpectedEvidence;
  context: () => Promise<SettlementClassifierContext>;
}>): Readonly<{ evaluate(evidenceId: string): Promise<StagedSettlementResult> }> {
  const denied = (reason: Extract<StagedSettlementResult, { ok: false }>['reason']): StagedSettlementResult =>
    ({ ok: false, reason, financialAuthorization: 'NOT_GRANTED' });
  return Object.freeze({
    async evaluate(evidenceId: string): Promise<StagedSettlementResult> {
      if (typeof evidenceId !== 'string' || !REFERENCE.test(evidenceId)) return denied('INVALID_REQUEST');
      // Prevent a production identity or observation purpose being routed through
      // the synthetic classifier. No production adapter is provided.
      if (deps.expected.environment !== 'development' ||
        deps.expected.purpose !== 'SYNTHETIC_TEST_EVIDENCE' ||
        deps.expected.evidenceType !== 'SYNTHETIC_TEST_EVIDENCE') return denied('BINDING_MISMATCH');
      try {
        const stored = await deps.lookup.load(evidenceId);
        if (!stored) return denied('EVIDENCE_UNAVAILABLE');
        const verified = await deps.verifier.verify(stored, deps.expected);
        if (!verified.ok || verified.authenticity !== 'AUTHENTIC' || verified.financialAuthorization !== 'NOT_GRANTED') return denied('SIGNATURE_UNVERIFIED');
        const ctx = await deps.context();
        if (!ctx || ctx.expected.businessId !== verified.claims.businessId) return denied('BINDING_MISMATCH');
        const p = verified.payload;
        if (!p || typeof p !== 'object' || Array.isArray(p) ||
            Object.keys(p).length !== 1 || !Object.prototype.hasOwnProperty.call(p, 'settlementEvidence')) return denied('BINDING_MISMATCH');
        const ev = p.settlementEvidence;
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return denied('BINDING_MISMATCH');
        const classification = classifySettlement(ctx, ev as MockSettlementEvidence);
        if (classification.verdict === 'UNRESOLVED') return denied('CLASSIFIER_UNRESOLVED');
        return { ok: true, classification, financialAuthorization: 'NOT_GRANTED' };
      } catch {
        return denied('EVIDENCE_UNAVAILABLE');
      }
    },
  });
}
