/**
 * B4-07 — evidence-based database verifier provider decision gate.
 *
 * All candidate protocols are NOT certified. This is not called by a route,
 * database function, middleware or signer and grants no authority.
 *
 * pg_session_jwt without an independently trusted configured JWK can read
 * mutable request.jwt.claims. A caller-provided "verified" flag is not proof.
 */
export const B407_VERIFIER_CANDIDATES = Object.freeze({
  pgcrypto: Object.freeze({
    candidate: 'pgcrypto',
    algorithm: 'HMAC / digests, no raw Ed25519 verification',
    dbEd25519Certified: false,
    claimIntegrityCertified: false,
    liveApproved: false,
  }),
  pgSessionJwt: Object.freeze({
    candidate: 'pg_session_jwt',
    algorithm: 'JWT with configured JWK; not the B4-03/1 detached Ed25519 wire contract',
    dbEd25519Certified: false,
    claimIntegrityCertified: false,
    liveApproved: false,
  }),
  pgjwt: Object.freeze({
    candidate: 'pgjwt',
    algorithm: 'JWT handling not certified as B4-03/1 detached Ed25519 verifier',
    dbEd25519Certified: false,
    claimIntegrityCertified: false,
    liveApproved: false,
  }),
  independentBrokerService: Object.freeze({
    candidate: 'independent-broker-service',
    algorithm: 'Service could verify B4-03 Ed25519 with WebCrypto before fixed SQL',
    dbEd25519Certified: false,
    claimIntegrityCertified: false,
    liveApproved: false,
  }),
} as const);

export type B407VerifierCandidate = keyof typeof B407_VERIFIER_CANDIDATES;
export type B407GateReason =
  | 'UNKNOWN_PROVIDER'
  | 'CLAIMS_FALLBACK_UNTRUSTED'
  | 'DETACHED_SIGNATURE_NOT_VERIFIED_IN_DB'
  | 'INDEPENDENT_BROKER_NOT_CERTIFIED';

export type B407GateResult = Readonly<{
  authorized: false;
  brokerEnabled: false;
  reason: B407GateReason;
}>;

/**
 * Explicitly denies all candidates, even caller-provided certification flags.
 * A separately reviewed implementation must replace this entire gate after
 * proof of issuer custody, workload isolation, nonowner role, use-time session
 * and permission checks, replay prevention, and tenant-safe pooling.
 */
export function evaluateB407VerifierProvider(
  candidate: unknown,
  options?: Readonly<{ jwkConfigured?: unknown; verified?: unknown; certified?: unknown }>,
): B407GateResult {
  if (typeof candidate !== 'string' ||
      !Object.hasOwn(B407_VERIFIER_CANDIDATES, candidate)) {
    return { authorized: false, brokerEnabled: false, reason: 'UNKNOWN_PROVIDER' };
  }
  if (candidate === 'pgSessionJwt' && options?.jwkConfigured !== true) {
    return { authorized: false, brokerEnabled: false, reason: 'CLAIMS_FALLBACK_UNTRUSTED' };
  }
  if (candidate === 'independentBrokerService') {
    return { authorized: false, brokerEnabled: false, reason: 'INDEPENDENT_BROKER_NOT_CERTIFIED' };
  }
  return { authorized: false, brokerEnabled: false, reason: 'DETACHED_SIGNATURE_NOT_VERIFIED_IN_DB' };
}
