/**
 * Provider-neutral visit-verification contract (Continuing Development
 * Block 4.2, S5.3). S5.3 names several distinct ways a customer might prove
 * a real visit: "receipt number, POS order identifier, one-time visit
 * token, table session, staff-issued visit session, external POS
 * reference." This interface is what keeps adding any of those later a new
 * file implementing VisitVerificationProvider, not a redesign of this
 * contract or of the two call sites that will eventually use it (feedback
 * submit, loyalty check-in -- wired in Block 4.3, not this block).
 *
 * Only ONE provider ships in Block 4.2: visit-session.service.ts, backed by
 * the staff-issued visit_sessions table (db/schema/visit-sessions.ts),
 * covering both the "table session" and "one-time visit token" flavors
 * S5.3 lists (see that schema file's own doc comment for how one table
 * covers both).
 *
 * Receipt-number, POS-order-ID, and external-POS-reference verification are
 * deliberately NOT built in this block. All three require validating
 * against a real point-of-sale system this Cloudflare account has no actual
 * integration or credentials for -- building a provider for them now would
 * mean either placeholder logic (forbidden by this project's own execution
 * rules: "never generate placeholder production code") or an invented,
 * unverified external API shape (equally not acceptable for production
 * code). They stay a documented future extension: implement
 * VisitVerificationProvider against whatever real POS API is actually
 * integrated, register it alongside StaffIssuedSessionProvider, no change
 * needed to this file or to the callers that consume the interface.
 */

/**
 * Deliberately minimal and provider-agnostic -- no field here is specific
 * to any one provider's underlying record (e.g. no `sessionId`). A
 * provider that wants to surface something provider-specific (a session's
 * remaining uses, a receipt's matched line item) puts it in `metadata`,
 * which callers treat as opaque/optional, never as part of the contract
 * every provider must populate.
 *
 * `reasonCode` is intentionally loose (`string`, not a literal union) --
 * this type is shared across every current AND future provider, and each
 * provider's internal failure taxonomy (expired vs exhausted vs not-found
 * vs a POS-specific rejection) is its own concern. Enumeration-resistance
 * (never letting an external caller distinguish WHY a verification failed)
 * is enforced by each provider's caller, not by narrowing this type -- see
 * visit-session.service.ts's verify() for how the one shipped provider
 * applies that principle.
 */
export interface VisitVerificationResult {
  readonly verified: boolean;
  readonly reasonCode?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * `proof` is a plain string, not a structured/generic type -- every
 * verification flavor S5.3 lists (a receipt number, a POS order id, a
 * typed session code, an external reference) reduces to "a string the
 * customer typed or a receipt/QR encoded." A provider that ever needs more
 * than one input value can still accept a single delimited or JSON-encoded
 * string; that's a provider-internal parsing concern, not a reason to widen
 * this interface for every other provider.
 */
export interface VisitVerificationProvider {
  readonly type: string;
  verify(businessId: string, branchId: string, proof: string): Promise<VisitVerificationResult>;
}
