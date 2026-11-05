import type { EvidenceOrigin, NormalizedStripeEvidence } from './evidence-types';

/**
 * Origin sealing. A bundle is trusted as "from a real test-mode read" or "from the mock provider" only if THIS module registered the very object (identity, not a field).
 * A bundle that was cloned, serialized, hand-built or has its `origin` edited is not registered and is rejected by the classifier bridge. This stops mock evidence from being
 * passed off as authentic provider evidence (and the reverse) through data alone. It is not a defence against malicious code running in the same process, which could call
 * `sealBundle`: in-process code is already inside the trust boundary, and the database-level controls from DEV-04/05 are what protect against everything outside it.
 * `sealBundle` is intentionally not exported from the package index.
 */
const sealed = new WeakMap<object, EvidenceOrigin>();

export function sealBundle(bundle: NormalizedStripeEvidence, origin: EvidenceOrigin): NormalizedStripeEvidence {
  if (bundle.origin !== origin) throw new Error('EVIDENCE_ORIGIN_MISMATCH');
  Object.freeze(bundle);
  sealed.set(bundle, origin);
  return bundle;
}

/** The origin the bundle was sealed with, or null when this object was not produced by a sealing module. Ignores whatever the object claims. */
export function sealedOriginOf(bundle: unknown): EvidenceOrigin | null {
  return bundle !== null && typeof bundle === 'object' ? sealed.get(bundle) ?? null : null;
}
