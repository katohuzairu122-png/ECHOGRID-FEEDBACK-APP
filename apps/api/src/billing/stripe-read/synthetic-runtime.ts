import { makeRuntime, type RuntimeParts, type TrustedReadRuntime } from './trusted-runtime';
import type { StripeReadTransport } from './transport';

/**
 * S08-D1D3-DEV-10: the SYNTHETIC trusted runtime. It wraps a test transport (a scripted fake or a stubbed `fetch`) and signs what the transport returns, but ONLY as `SYNTHETIC_RUNTIME`: the key ring
 * must list its signing key with the purpose SYNTHETIC_RUNTIME, and a verifier asked for REAL_NETWORK evidence refuses its observations by kind and by key purpose, whatever the transport claims.
 * It exists so the internal verification chain (authorization -> gate -> credential -> signature -> verifier -> normalizer -> pipeline) is testable without impersonating a real Stripe response.
 * It is not exported from the package index and nothing outside tests and fixtures constructs it.
 */
export function createSyntheticTrustedRuntime(deps: RuntimeParts & Readonly<{ transport: StripeReadTransport }>): TrustedReadRuntime {
  return makeRuntime('SYNTHETIC_RUNTIME', deps.transport, deps);
}
