import type { SignedEvidenceCustodyService } from './signed-evidence-custody';
import {
  classifySettlement, type MockSettlementEvidence, type SettlementClassification,
  type SettlementClassifierContext,
} from '../settlement-eligibility.classifier';

/**
 * DEV-17: an inert, development-only bridge to the actual DEV-15 custody
 * retrieval boundary. Custody itself verifies the original signature, key
 * lifecycle, RLS, tenant authority, and immutable record before returning.
 *
 * This module never signs evidence, grants financial authority, invokes the
 * DEV-03 recorder, calls Stripe, or touches the D4 consumption writer.
 * Do not expose this function to an HTTP route.
 */
export type CustodyClassificationResult =
  | Readonly<{ ok: true; classification: SettlementClassification; evidenceId: string; financialAuthorization: 'NOT_GRANTED' }>
  | Readonly<{ ok: false; reason: 'INVALID_REQUEST' | 'CUSTODY_UNAVAILABLE' | 'CUSTODY_UNVERIFIED' | 'BINDING_MISMATCH' | 'CLASSIFICATION_UNRESOLVED'; financialAuthorization: 'NOT_GRANTED' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = (x: object, k: string) => Object.prototype.hasOwnProperty.call(x, k);
const deny = (reason: Extract<CustodyClassificationResult, { ok: false }>['reason']): CustodyClassificationResult =>
  ({ ok: false, reason, financialAuthorization: 'NOT_GRANTED' });

/** Strictly dependent upon the real custody service, never a caller-asserted 'verified' flag. */
export function createCustodySettlementClassificationStage(deps: Readonly<{
  custody: SignedEvidenceCustodyService;
  context: () => Promise<SettlementClassifierContext>;
}>): Readonly<{ evaluate(evidenceId: string): Promise<CustodyClassificationResult> }> {
  return Object.freeze({
    async evaluate(evidenceId: string): Promise<CustodyClassificationResult> {
      if (typeof evidenceId !== 'string' || !UUID.test(evidenceId)) return deny('INVALID_REQUEST');
      try {
        const ctx = await deps.context();
        const businessId = ctx?.expected?.businessId;
        if (typeof businessId !== 'string' || !UUID.test(businessId) || !Number.isSafeInteger(ctx.nowMs) ||
          ctx.nowMs < 0 || !ctx.policy || !ctx.expected.frozenAllocation) return deny('BINDING_MISMATCH');

        // DEV-15 resolves the custodian workload from trusted runtime configuration,
        // checks its tenant allowlist, re-verifies the signature, and audits the read.
        const stored = await deps.custody.retrieve({
          evidenceId, businessId, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE',
        });
        if (!stored.ok) return deny('CUSTODY_UNAVAILABLE');
        if (stored.authenticity !== 'AUTHENTIC' || stored.financialAuthorization !== 'NOT_GRANTED' ||
          stored.claims.businessId !== businessId || stored.claims.environment !== 'development' ||
          stored.claims.purpose !== 'SYNTHETIC_TEST_EVIDENCE' || stored.claims.evidenceType !== 'SYNTHETIC_TEST_EVIDENCE') return deny('CUSTODY_UNVERIFIED');

        const payload = stored.payload as Record<string, unknown>;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || !own(payload, 'settlementEvidence')) return deny('BINDING_MISMATCH');
        const ev = payload.settlementEvidence;
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return deny('BINDING_MISMATCH');
        const mock = ev as MockSettlementEvidence;
        if (mock.binding?.businessId !== businessId ||
          mock.binding.reservationId !== ctx.expected.reservationId ||
          mock.binding.intentRef !== ctx.expected.intentRef ||
          mock.invoice?.id !== ctx.expected.invoiceRef ||
          mock.provider?.accountId !== ctx.expected.providerAccountId ||
          mock.provider.mode !== ctx.expected.providerMode) return deny('BINDING_MISMATCH');

        // The existing pure classifier is the only settlement decision maker.
        // Even ELIGIBLE is not permission to persist an authorization or consume.
        const classification = classifySettlement(ctx, mock);
        if (classification.verdict === 'UNRESOLVED') return deny('CLASSIFICATION_UNRESOLVED');
        return { ok: true, classification, evidenceId, financialAuthorization: 'NOT_GRANTED' };
      } catch {
        return deny('CUSTODY_UNAVAILABLE');
      }
    },
  });
}
