# ECHO GRID — Split 08 CE-1 Inert Reservation & Application Persistence

**Disposition: DATABASE FOUNDATIONS ONLY — NO APPLICATION AUTHORITY FREEZE.**

## Additive SQL migration
`0042_split08_ce1_inert_evidence.sql` adds:
- `partner_credit_reservations`: business/decision/lot/account references, unique lot and business + invoice-intent allocation, unique idempotency key, unit constraint = 1, reservation/release/consumed status and timestamp consistency.
- `billing_partner_credit_applications`: unique reservation, business/invoice and provider-success references, subscription relation, unique idempotency, terminal `applied` status, applied timestamp and integer-unit invariant.
- **Database-level INSERT/UPDATE/DELETE denial triggers on both tables.** They have no session variable override, and the migration does not weaken any prior economic barriers.

This is a deliberately SQL-owned, inert foundation: it does not yet add Drizzle TS table mappings or an enabled writer. Migration 0042 has a metadata snapshot chain entry matching the previous Drizzle schema; a future typed implementation MUST add both schema definitions and generate the corresponding migration/snapshot diff before activation. An inert table is not evidence of a successful Stripe application.

## Postgres tests
The existing isolated Partner Award integration suite verifies:
- ordinary database inserts are denied by the new trigger;
- disposable-test-only inserts satisfy the new foreign keys;
- duplicate reservation lot and duplicate application-for-reservation are rejected by PostgreSQL unique constraints;
- an attempted nonterminal application status is rejected by the database check constraint;
- even a structurally stored `applied` application with a still-`reserved` allocation is **not authoritative consumption**.

Isolated testing temporarily disables the new two triggers only in `PARTNER_AWARD_TEST_DATABASE_URL`, which is a separate disposable CI database; it re-enables them in `finally`. No production schema mutation or trusted provider integration is performed.

## Required before the contract is frozen
1. Create authoritative provider-verified invoice application state via Split 08, with strict subscriber/business and eligible invoice checks; maintain provider signature/event reconciliation independent of client data.
2. Implement trusted SQL-backed lookup that correlates an actually consumed reservation with the application's immutable provider-success receipt.
3. Implement Split 07 account/lot reservation transactions and ledger conservation with settlement-first lock ordering, timeout/release/retry races, authorization checks and no-negative account projection.
4. Implement separately privileged terminal consumption writer with exact-once app/lot/invoice guarantees, durable external outcomes and transactional or outbox-based failure recovery.
5. Implement consumed-credit reversal recovery obligations only after authoritative application proof. This must not mutate settled invoices or Stripe history.
6. Review economics, database privileges, expansion to typed Drizzle schema, migration snapshots, rollback strategy, concurrency and invariant scans.

**Status:** Migration 0042 is additive and inert. No Split 07 Block 2 completion lock, no Split 08 freeze and no Partner Credit activation. Manual production migration policy remains unchanged.
