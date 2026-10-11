# Split 08 — CE-1 Reservation/Application PostgreSQL Persistence Gate

**Status: SCHEMA VERIFIED BY CODE INSPECTION; CI RUNTIME PENDING. ECONOMIC ACTIVATION DENIED.**

## Existing source of truth foundations
Migration 0042, already merged, creates `partner_credit_reservations` (Split 07-owned reservation structure) and `billing_partner_credit_applications` (Split 08-owned terminal structure). The Drizzle schema mirrors it. Do not create duplicate tables or renumber migrations. Both tables have database mutation-denial triggers (`partner_credit_reservations_inert_guard`, `billing_partner_credit_applications_inert_guard`); their guards remain on in ordinary environments and production.

## Test added
The isolated PostgreSQL suite explicitly disables only the test database's six existing denial triggers, including these two, then restores them. A verified Split 06 fulfillment/award fixture creates an actual Partner Credit lot and account. The test inserts one reservation, verifies a duplicate lot cannot be reserved again, inserts a synthetic billing application linked to a real business-subscription row, proves a second application for the same reservation is rejected, checks unit constraints and confirms **the synthetic application has not moved any credit balances**. This is a database-schema constraint test, not an invoice-finalization proof.

## Remaining architecture and database gaps
- Schema FKs currently validate each referenced ID individually but do not ensure `reservation.business_id = decision.business_id = account.business_id`, `reservation.lot_id` belongs to its `decision_id/account_id`, or `application.business_id = reservation.business_id = subscription.business_id`. These cross-record tenant checks must be enforced under locks in a reviewed trusted writer and preferably DB constraints before any economic activation. A structural row alone is insufficient authority.
- Reservation records do not yet represent a verified live available-unit deduction, authoritative invoice intent, or terminal cancellation; no reservation writer is wired to production routes.
- Application rows contain a provider-success string but have **no trusted Stripe invoice verification/reconciliation adapter**. Do not create them based on raw webhooks, client-supplied fields or an invoice preview.
- Immutable application history, unique provider idempotency, exactly-once cancellation/consumption, cross-tenant replay, deadline races and lock ordering must be proven against the final integrated writer.
- Split 07 reversal must reject consumed lots until it can verify a frozen Split 08 terminal application record; the recovery obligation writer is not authorized.

## Disposition
**DO NOT DECLARE CE-1 FROZEN.** Runtime validation of the existing persistence constraints is only an intermediate milestone; final Split 08 economic authority and Split 07 Block 2 completion locks are withheld. Keep 0041/0042 denial guards and Stripe/business subscription/Community Points/loyalty balances unchanged.

**Next gate:** Cross-table tenant-integrity hardening, authoritative Stripe invoice-finalization verifier, and gated reservation/consumption writer with race-safe PostgreSQL tests.
