# Split 07/08 — Immutable Provider Observation Foundation

**Status:** inert evidence foundation; NOT provider-reconciled effective-window authority; NOT an economic activation.

## What exists
- Additive migration 0043 creates append-only Stripe subscription event observations with unique provider event id and tenant/business/subscription/customer/price associations.
- The existing signature-verifying webhook route calls a recorder **only after** signature verification and normal mirror sync. Duplicate event IDs are idempotent. Events without one well-formed subscription item, provider period, Stripe IDs, or matching persisted tenant Stripe identifiers are skipped, not guessed.
- Durable `provider_payload` records the subscription object supplied in the signed event. The row is not a statement that the subscription price was in force for all of its billing period.
- A read-only historical tier reader returns explicit fail-closed results for missing history, mismatch, and unprovable effective windows. All outcomes have `historicalTierVerified:false`, `issuanceAuthorized:false`.

## What does NOT exist
- No trusted effective-from/effective-to evidence for exact subscription price transitions. Stripe `event.created`, receipt order and subscription item period dates cannot establish a mid-period price transition.
- No provider backfill or automatic promotion of an observation into authoritative historical pricing.
- No award decision integration, credit issuance, multi-unit accounting, Stripe mutation or changes to the 0041/0042 blockers.
- No proof of 0043 migration correctness in disposable PostgreSQL until its isolated CI verification passes.

## Required next independent gate
Define and verify a provider-reconciled price-effective interval source, including races, webhook disorder, price changes and customer identity, and only then allow a positive tier-at-fulfillment verifier. Explicitly review whether any subscription-history segment cannot be reconstructed from available Stripe evidence and reject unprovable intervals. Do not silently treat received events as an authoritative timeline.
