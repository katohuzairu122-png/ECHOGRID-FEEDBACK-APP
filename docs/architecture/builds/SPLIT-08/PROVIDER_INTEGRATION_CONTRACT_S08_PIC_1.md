# ECHO GRID — SPLIT 08 PROVIDER INTEGRATION CONTRACT

Specification: S08-PIC/1
Status: Proposed — not production-authorized
Architecture: Preserve Split 07, Split 08, HETA and existing tenant boundaries.

## A. Provider Identity

Every provider operation must establish:

- ECHO GRID business ID
- Partner Credit reservation ID
- Application intent ID
- Stripe account identity
- Stripe operating mode (test/live)
- Stripe customer ID
- Subscription ID
- Invoice ID
- Currency
- Policy version
- Stable idempotency key

Reject incomplete, cross-business, conflicting, or unauthenticated identity evidence.

## B. Provider Write Boundary

The provider write adapter must:

1. Accept only an authorized, persisted application intent.
2. Use a deterministic reservation-derived idempotency key.
3. Validate the invoice and provider scope immediately before mutation.
4. Apply only the specifically approved benefit amount.
5. Never silently substitute a different invoice or subscription.
6. Preserve retry identity following timeouts.
7. Return a provider operation reference, not an assertion of successful credit consumption.

The exact Stripe adjustment instrument requires a separate owner decision.

## C. Reconciliation Contract

The existing read-only reconciliation implementation remains authoritative.

A reconciled effect requires:

- Matching provider account and operating mode.
- Matching invoice, customer and subscription.
- Exact reservation attribution.
- Exact expected currency and amount.
- Complete, independently obtained provider evidence.

Unknown, partial, mismatched, or unreachable observations must retain the pending obligation.

Absence must not be inferred from one provider read.

## D. Consumption Contract

Final credit consumption requires a separately authorized transactional service.

It must verify:

1. Provider effect independently reconciled.
2. Invoice settlement requirement satisfied.
3. Correct tenant and reservation identity.
4. No unresolved duplicate, dispute, reversal, or compensation obligation.
5. No previously committed consumption.
6. All immutable ledger and accounting invariants remain valid.

No provider response directly mutates the Partner Credit ledger.

## E. Recovery and Compensation

- Retry unknown outcomes using the original provider idempotency identity.
- Maintain a durable reconciliation record.
- Never repeat an economic action because the initial HTTP response was lost.
- Preserve immutable evidence of disputes and reversals.
- Require separate authorization for compensating financial operations.
- Escalate irreconcilable states without inventing a successful outcome.

## F. Acceptance Tests

Required before activation:

- Duplicate submission
- Concurrent application attempts
- Timeout after successful provider mutation
- Provider rate limitation
- Wrong account or mode
- Cross-business substitution
- Incorrect invoice or currency
- Wrong benefit amount
- Unattributed benefit
- Partial pagination
- Unknown provider outcome
- Duplicate provider effect
- Reservation expiry
- Reversal during application
- Multiple credits targeting one invoice
- Recovery after process crash
- Concurrent final settlement

All tests must demonstrate conservation of Partner Credit balances and fail-closed behavior.

## G. Release Restrictions

Until explicitly certified:

- No Stripe benefit writes
- No production financial activation
- No credit consumption
- No production migration
- No deployment
- No weakening of authorization or evidence requirements

Development must stop at any conflict with frozen architecture or unresolved owner decisions.
