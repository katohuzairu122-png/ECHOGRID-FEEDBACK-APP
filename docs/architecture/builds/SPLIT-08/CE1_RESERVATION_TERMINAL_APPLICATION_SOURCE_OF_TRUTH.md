# ECHO GRID — Split 08 Authoritative Reservation and Terminal Application Source of Truth

**Stage:** Architecture reconciliation + fail-closed source contract; **not frozen, not active**.

## Existing authority
- Split 06: fulfilled settlement and reversal evidence.
- Split 07: Partner Credit award decisions, accounts, lots, FIFO recovery obligations and immutable credit movement ledger.
- Split 08: subscription billing, invoice eligibility, provider reconciliation, monetary application outcome and retained billing history.
- Existing billing routes create Stripe Checkout/Portal sessions; these are not invoice-level application success proofs.

## Binding contract CE-1 candidate
An invoice intent is not a reservation, a reservation is not a consumed credit, and a Stripe event alone is not a terminal Partner Credit application. Split 08 must persist and resolve an application row with immutable `applicationRef`, `reservationRef`, `businessId`, `decisionId`, `lotId`, `unitsApplied`, `invoiceRef`, `subscriptionRef`, provider success reference, terminal status, applied UTC timestamp and versioned benefit policy.

### Reservation (Split 07 writer, authorized by Split 08 invoice intent)
1. Resolve and lock the original Split 06 settlement, award decision, originating lot, business account and recovery obligations under an approved, deadlock-free global lock order.
2. Verify vested unexpired unencumbered credit, absence of source reversal and zero unresolved recovery debt. Reserve exactly one unit once, with immutable invoice intent reference, unique idempotency key and expiration/deadline.
3. Move one available unit to reserved, record allocation, return reference only. Do not call Stripe or calculate monetary amount.
4. Release on verified cancellation, failed invoice application or expired intent without consumption. Preserve history and do not release a unit after terminal success. All races resolve to exactly one terminal transition.

### Final application (Split 08)
1. Verify finalized eligible invoice, subscription identity, plan interval, tax/rounding/proration policy, actual provider-authoritative application success and reconciliation.
2. Persist one unique terminal application with FK/unique constraints for reservation, invoice and credit lot allocation. Replays return same result without writing additional application rows.
3. Make a trusted transactionally queryable lookup available to Split 07; client JSON or a webhook payload is not authoritative.
4. Split 07 moves reserved to consumed **only** after successfully reading that verified terminal row and reconciling all reservation and lot references.
5. A lost race against reversal, expiry, cancellation, or release must fail closed. Never generate credit consumption from an invoice quote.

### Recovery after consumption (Split 07)
Only after verified Split 08 application is durable may Split 07's authoritative reversal transaction append one compensating entry and create a recovery obligation. Preserve all past invoice and Stripe history; future earned credits offset the noncash obligation at vesting. Invoice refunds/adjustments remain Split 08-only.

## Mandatory database and security design gates
- New persisted tables with indexes for `partner_credit_reservations` (Split 07) and `billing_partner_credit_applications` (Split 08), immutable invoice-success references and DB-enforced uniqueness.
- Independent evidence lookup restricted to internal authorization and verified application status; scope every key by business and original reservation.
- Schema/migration replay, unique keys, transaction isolation and deadlock review, expiry and cancellation races, repeated webhook delivery, 11-way cross-branch award/regression, credit reservation collision, and cross-business tamper tests.
- Full money-unit interpretation requires separate Split 08 approval, including eligible invoice base, yearly subscriptions, trial/cancellation/refund policy and Stripe application semantics.
- Never turn off migration 0041 triggers as part of this specification or claim real credit consumption until DB privilege/boundary release is separately approved.

## What this PR actually ships
Only a pure reservation-state validator and a structural comparison of evidence *after* a hypothetical trusted lookup. The returned `TrustedApplicationLookup` is **not** a secure proof type; the only current stub returns `not_found`. There are no new tables, writer, operational reservation or Stripe application flows. The tests are negative contract tests, **not PostgreSQL economic or Stripe integration tests**.

**Decision:** authority not frozen. Source-of-truth persistence, provider-success proof, authorized reservation writer, trusted lookup, consumed-credit reversal and obligation writer remain blocked. Split 07 Block 2 lock and economic activation remain withheld.
