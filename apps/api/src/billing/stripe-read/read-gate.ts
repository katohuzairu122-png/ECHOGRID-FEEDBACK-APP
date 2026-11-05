import type { ReadMethodId } from './capability-registry';
import { authorizeRead, type AuthorizationDenial, type ReadAuthorizationStore } from './read-authorization';
import type { MappingRegistry } from './mapping-authority';

/**
 * S08-D1D3-DEV-09: the READ GATE evaluated immediately before every real provider request. Two independent conditions, both required:
 *   1. a durable, approved, unrevoked, in-period authorization record for this business, account, workload and method (read-authorization.ts), and
 *   2. the field-mapping status of that operation, which depends on WHY the read is made:
 *        EVIDENCE  feeds the acquisition pipeline: needs TEST_MODE_VERIFIED. Until a proof exists no real evidence read is possible at all.
 *        PROOF     captures a response to verify the mapping: may run while the mapping is SDK_SCHEMA_UNPROVEN_LIVE or SCHEMA_DRIFT (that is its purpose); never while UNSUPPORTED.
 * The gate is stateless and re-reads both on every call, so a revocation or a mapping change takes effect on the next request. There is no setting, environment variable or default that relaxes it.
 */
export type GatePurpose = 'EVIDENCE' | 'PROOF';
export type GateDenial = AuthorizationDenial | 'MAPPING_NOT_VERIFIED' | 'MAPPING_UNSUPPORTED' | 'MAPPING_DRIFT';
export interface ReadGate {
  readonly store: ReadAuthorizationStore;
  /** Identity of THIS verifier workload, from trusted runtime configuration. Never taken from a request. */
  readonly workloadId: string;
  /** The current mapping state (a registry loaded from persisted mapping state and proofs). */
  readonly mapping: MappingRegistry;
}
export type GateDecision = Readonly<{ ok: true; authorizationId: string; authorizationVersion: number }> | Readonly<{ ok: false; reason: GateDenial }>;

export async function checkRead(
  gate: ReadGate,
  q: Readonly<{ businessId: string; accountId: string; methodId: ReadMethodId; apiVersion: string; purpose: GatePurpose }>,
  nowMs: number,
): Promise<GateDecision> {
  if (!gate || !gate.store || typeof gate.workloadId !== 'string' || !gate.mapping || (q.purpose !== 'EVIDENCE' && q.purpose !== 'PROOF')) return { ok: false, reason: 'INVALID_REQUEST' };
  const a = await authorizeRead(gate.store, { businessId: q.businessId, accountId: q.accountId, workloadId: gate.workloadId, methodId: q.methodId, realm: 'test' }, nowMs);
  if (!a.allowed) return { ok: false, reason: a.reason };
  const status = gate.mapping.operationStatus(q.methodId, q.apiVersion);
  if (status === 'UNSUPPORTED') return { ok: false, reason: 'MAPPING_UNSUPPORTED' };
  if (q.purpose === 'EVIDENCE') {
    if (status === 'SCHEMA_DRIFT') return { ok: false, reason: 'MAPPING_DRIFT' };
    if (status !== 'TEST_MODE_VERIFIED') return { ok: false, reason: 'MAPPING_NOT_VERIFIED' };
  }
  return { ok: true, authorizationId: a.record.authorizationId, authorizationVersion: a.record.version };
}
