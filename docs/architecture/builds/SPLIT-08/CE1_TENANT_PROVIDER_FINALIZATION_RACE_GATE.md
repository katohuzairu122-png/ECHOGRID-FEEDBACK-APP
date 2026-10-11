# ECHO GRID — Split 08 CE-1 Tenant Integrity and Provider Authority Review

**Gate: PARTIAL, FAIL CLOSED.** This PR does not activate credit issuance, application or recovery.

## Inspected ownership and consistency
- Split 06 settlement reversal is a platform-admin-authorized transaction, locks settlement before decision/lot/account, and rolls back when Split 07 compensation rejects an encumbered lot.
- Split 07 reservation writer is currently internal, rejects missing fulfilled settlement/eligible lot/recovery-debt issues; it has no trusted invoice-intent authorization and production guards block its writes. Cancellation/release remains intentionally denied.
- Split 08 application persistence (migration 0042) permits an inert application-shaped row in disposable test databases only. Its FK relations are individually valid but cross-tenant invariants are not enforced by composite constraints.
- Stripe webhook route authenticates event signatures, but existing subscription synchronization does **not** independently verify that a credit reduced a finalized invoice. A signed invoice event alone is not proof of the desired credit application.

## Added read-only relational inspection
`PartnerCreditApplicationIntegrityReader.inspect(applicationId)` loads the application, reservation, decision, lot, account, and mirrored subscription, and fails closed on mismatched business ownership, wrong lot/decision/account references, unsupported terminal status/timestamps, or absent provider references. Even when all relational fields match, it returns `relations_consistent_unverified` — **never a verified consumption entitlement**.

## Required Stripe invoice verification (NOT implemented)
Design and freeze a dedicated Split 08 provider reconciliation protocol before economic writes:
1. Fetch the canonical Stripe invoice server-side using the platform Stripe client; verify invoice is finalized and properly paid/applied per an approved financial treatment, matching expected subscription, customer, currency, period, credit instrument and amount adjustment semantics. Reconcile to the business subscription using immutable provider IDs.
2. Prove that the specific Partner Credit application was actually committed to that invoice, not merely that an ordinary invoice succeeded. Distinguish draft/void/uncollectible/paid, retries, credits, refunds, prorations, annual plans, tax/rounding and out-of-order webhooks.
3. Persist immutable provider-verified terminal application evidence with unique invoice/reservation/lot/idempotency constraints. Test replay, cross-business references, released/expired reservations, race with Split 06 reversal, and lock order.
4. Implement a writer that **only** consumes an existing reserved unit after provider-authoritative success and a matching reservation, while preserving immutable invoice history and using a single transaction for all Split 07 projections.
5. Prove failed provider verification leaves both reservation and credit balances unchanged. Restore all 0041/0042 guard triggers in isolated tests. Do not remove them in production until an explicit approved activation migration.

## Existing schema risk
Individual foreign keys do not establish the equality of tenant keys across application → reservation → decision/lot/account → subscription. The reader detects this on reads but cannot replace DB-enforced composite constraints and transaction-time locking. An additive future schema hardening migration needs Drizzle snapshot compatibility and end-to-end PostgreSQL validation before activation.

**Disposition:** CE-1 freeze withheld. No Stripe monetary changes, no reservation consumption/cancellation activation, no consumed-credit recovery-obligation writes. Split 07 Block 2 completion lock withheld.
