import type { PolicyChange, PolicyStatus } from './policy-administration';

/**
 * S08-D1D3-DEV-13: the SEALED policy-activation contract. It exists so that a future, separately designated OWNER authority has a defined, testable set of preconditions to satisfy, and so that today's code can be
 * shown to have NO activation path.
 *
 *  - `evaluateActivationPreconditions` is pure: it says what an approved request must look like before anything may consider activating the policy. It writes nothing.
 *  - `activatePolicy` ALWAYS refuses. It requires an `OwnerActivationAuthority`; the only registry of valid authorities is a WeakSet this module never adds to, and no export constructs one. Designating that authority
 *    (who it is, how it is provisioned, how it is audited) is an explicit owner decision this development does not make. Even a hypothetical sealed authority gets `ACTIVATION_NOT_IMPLEMENTED`: there is no code that writes `approval_enabled`.
 * No environment variable, request field, approved proposal or administrator role changes any of this.
 */
declare const BRAND: unique symbol;
export interface OwnerActivationAuthority { readonly [BRAND]: true }
const designated = new WeakSet<object>(); // intentionally never populated by this codebase
export const isOwnerActivationAuthority = (x: unknown): x is OwnerActivationAuthority => x !== null && typeof x === 'object' && designated.has(x);

export type ActivationDenial =
  | 'AUTHORITY_NOT_DESIGNATED' | 'ACTIVATION_NOT_IMPLEMENTED' | 'CHANGE_NOT_APPROVED' | 'CHANGE_EXPIRED' | 'POLICY_UNREADABLE' | 'VERSION_STALE' | 'TARGET_NOT_ENABLE' | 'ALREADY_ENABLED' | 'SAME_ADMINISTRATOR' | 'DECISION_MISSING';
export type ActivationPreconditions = Readonly<{ ok: true }> | Readonly<{ ok: false; reasons: readonly ActivationDenial[] }>;

export function evaluateActivationPreconditions(change: PolicyChange | null | undefined, policy: PolicyStatus | null | undefined, nowMs: number): ActivationPreconditions {
  const reasons: ActivationDenial[] = [];
  if (!change || typeof change !== 'object') return { ok: false, reasons: ['CHANGE_NOT_APPROVED'] };
  if (!policy || policy.state === 'UNKNOWN' || policy.version === null) reasons.push('POLICY_UNREADABLE');
  if (change.storedState !== 'APPROVED') reasons.push('CHANGE_NOT_APPROVED');
  if (!Number.isSafeInteger(nowMs) || nowMs >= change.expiresAtMs) reasons.push('CHANGE_EXPIRED');
  if (policy && policy.version !== null && policy.version !== change.expectedPolicyVersion) reasons.push('VERSION_STALE');
  if (change.targetState !== true) reasons.push('TARGET_NOT_ENABLE');
  if (policy && policy.approvalEnabled === true) reasons.push('ALREADY_ENABLED');
  if (change.decidedBy === null || change.decisionRef === null) reasons.push('DECISION_MISSING');
  else if (change.decidedBy === change.proposedBy) reasons.push('SAME_ADMINISTRATOR');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** Always refuses. There is no implementation behind it. */
export async function activatePolicy(authority: unknown, _change: unknown, _nowMs: number): Promise<Readonly<{ ok: false; reason: ActivationDenial }>> {
  if (!isOwnerActivationAuthority(authority)) return { ok: false, reason: 'AUTHORITY_NOT_DESIGNATED' };
  return { ok: false, reason: 'ACTIVATION_NOT_IMPLEMENTED' };
}
