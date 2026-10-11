# Split 08 — Typed CE-1 Persistence, Reservation Candidate and Evidence Reader

**Status: DRAFT, INTERNAL, INERT. No CE-1 economic activation or completion lock.**

## Schema reconciliation
Migration 0042 already created `partner_credit_reservations` and `billing_partner_credit_applications` with unconditional insert/update/delete denial triggers. This block maps both into Drizzle table models and reconciles the 0042 snapshot (no additional runtime DDL or changes to 0041). The existing production migration policy remains manual.

## Atomic reservation candidate
The internal `PartnerCreditReservationService.reserve` transaction locks the originating Split 06 settlement and claim, rejects reversals, then locks the Split 07 decision and lot, and the credit account before mutating reservations and projections. It requires a vested, unexpired, one-unit lot and no outstanding recovery obligation. It enforces one reservation per lot, an idempotency key bound to all allocation parameters, and atomically changes one available unit into one reserved unit.

**Critical:** No authenticated billing-invoice intent source invokes this service; its input is not proof of eligible invoice authorization. The 0041 and 0042 triggers still reject live economic writes. For isolated tests only, 0041 economic guards and the 0042 reservation guard are temporarily disabled in a disposable PostgreSQL database.

## Release and terminal application
`release` reopens the same settlement-first transaction and validates relations, but **always denies the actual release** until trusted Split 08 invoice cancellation/failure evidence is frozen. The database-backed `PartnerCreditTerminalEvidenceReader` verifies tenant/subscription/reservation/lot relationship consistency, but **never returns a verified consumption result** because the current table stores a self-asserted provider reference without trusted reconciled provider success. A persisted `terminal_state='applied'` row is **not** independent evidence of billing application. No webhook, user payload, or staff adjustment may upgrade it to such proof.

## Outstanding conservation and race gates
- Reservation and release ledger movements have not been added to the frozen Partner Credit ledger taxonomy. The reservation record supplies only a structural audit; ledger-wide conservation and release/consume event semantics must be frozen and tested independently.
- The current lot-unique reservation index prohibits reuse after release. That is intentional fail-closed behavior for this candidate, not a final release/retry design.
- Authoritative provider-source invoice application must be built with server-side evidence, immutable billing reconciliation and invoice eligibility.
- Consumption-vs-reversal, reservation-vs-vesting, duplicate application, expiry, cancellation, and recovery-obligation races require concurrent PostgreSQL tests.
- Least-privilege, DB-enforced activation (not discretionary trigger disabling), typed schema/migration drift, ledger balances and end-to-end Stripe confirmation must pass before activation.

**Gate decision:** This is an internal transaction foundation and conservative reader, not a deployed reservation service. Do not merge as evidence of full Split 08 completion, do not declare CE-1 frozen, and do not activate Split 07 awards or billing credits.
