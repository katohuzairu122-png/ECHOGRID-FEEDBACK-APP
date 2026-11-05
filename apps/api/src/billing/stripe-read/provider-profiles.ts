/**
 * S08-D1D3-DEV-07: provider-version-specific mapping profiles. A normalizer maps a provider object ONLY under a profile registered here for the exact API version it was read with;
 * an API version with no profile is not "close enough": every category read under it is UNRESOLVED (API_VERSION_UNSUPPORTED).
 *
 * Provenance of the shapes: the Stripe SDK type definitions locked in this repository (stripe@22.3.2, whose own API version is 2026-06-24.dahlia). They establish that a field EXISTS with
 * a given name and type; they do not establish live behaviour, enum completeness for the pinned version, or that every response carries the field. That proof (Q1/Q2) has not been
 * performed, so every profile is `SDK_SCHEMA_UNPROVEN_LIVE` and nothing in this tree may describe a mapping as verified against Stripe.
 */
export type MappingProof = 'SDK_SCHEMA_UNPROVEN_LIVE';
export interface ProviderProfile {
  readonly apiVersion: string;
  readonly profileId: string;
  readonly proof: MappingProof;
  readonly sdkReference: string;
  /** Categories this profile defines a mapping for. */
  readonly categories: readonly ('invoice' | 'invoice_lines' | 'invoice_payments' | 'refunds' | 'disputes')[];
}

export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = Object.freeze({
  '2026-05-27.dahlia': Object.freeze({
    apiVersion: '2026-05-27.dahlia', profileId: 'stripe-2026-05-27.dahlia/schema-v1', proof: 'SDK_SCHEMA_UNPROVEN_LIVE' as const,
    sdkReference: 'stripe@22.3.2 type definitions (SDK API version 2026-06-24.dahlia)',
    categories: Object.freeze(['invoice', 'invoice_lines', 'invoice_payments', 'refunds', 'disputes'] as const),
  }),
});

/** The profile for exactly this API version, or null. Prototype keys, case variants, whitespace variants and non-strings have none. */
export function profileFor(apiVersion: unknown): ProviderProfile | null {
  return typeof apiVersion === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_PROFILES, apiVersion) ? PROVIDER_PROFILES[apiVersion]! : null;
}
