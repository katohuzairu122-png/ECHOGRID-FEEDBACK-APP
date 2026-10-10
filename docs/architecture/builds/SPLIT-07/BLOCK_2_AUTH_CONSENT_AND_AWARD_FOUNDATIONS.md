# Split 07 Block 2 — Authenticated Consent & Award Transaction Foundations

**Scope:** Development candidate, not live Partner Credit issuance.

## Server session authority
`/api/v1/partner-credits/consent/terms` and `/accept` use existing JWT authentication, active-user checks, resolved tenant, business-wide scope and `billing:manage` permission. Impersonated sessions are rejected for acceptance. The client must affirm `accepted:true` and submit the exact SHA-256 of a server-pinned PC-ECON/1 statement. The only consenting identity passed into `PartnerEnrollmentService` comes from `c.get('userId')` after middleware verification. The service writes acceptance evidence and audit atomically; a separate active platform administrator must approve enrollment using the receipt.

## Provisional award transaction foundations
`PartnerProvisionalAwardPlanner` implements a read-only transaction that locks the receiving business row, then the matching settlement row, resolves enrollment and frozen policy, and calculates business-wide UTC-month awarded units. It intentionally does **not** create decisions, lots, ledger movements or account balances and does not yet prove complete Split 06 fulfillment and reversal evidence; that full evidence revalidation must occur in the same future write transaction. The prospective award writer must serialize through shared business and settlement locks, enforce idempotency and full reversal handling, guarantee account-ledger-lot conservation and only then replace Block 1 guards through a separate gated migration.

## Deliberate pending gates
1. CI and fresh Postgres replay on exact commit.
2. Further positive/negative integration tests for actual settled fulfillment evidence and reversal race.
3. Canonical terms presentation/version ownership and replay/expiry semantics of acceptance records; note that a generic internal service invocation is not an authenticated public request.
4. Multiple concurrent enrollments and 11 awards across branches; database atomicity, lock order, rollback, and full projection/ledger conservation.
5. No granting new business roles or write endpoint for award mutations.
6. No 0041 guard disablement, vesting, Stripe, subscription invoice or cash conversions.

**Production issuance remains DISABLED.**
