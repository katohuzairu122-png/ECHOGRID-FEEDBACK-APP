# S08 inert allocation storage — migration 0052

Date: 2026-11-02. Development migration package; no deployment or financial activation.

## Entry and scope

The owner confirmed PR #192 merged after requesting the next inert persistence block. Authoritative main was fetched at `f60ef11fb413ce19e19f022aa39a62fe0dd82a71`. Its [post-merge CI](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/41501024352) passed. This implements the bounded storage step described by the [persistence contract](S08_PERSISTENCE_CONTRACT_AND_MIGRATION_READINESS.md); it does not resolve the separately gated append, authenticated provider or final accounting contracts.

Migration `0052_s08_inert_allocation_freezes` adds typed `s08_allocation_freezes` and `s08_allocation_freeze_items` mappings, generated Drizzle snapshot/journal integration, and SQL-owned protections. The prior 85 table snapshots are unchanged; two tables are added. Migrations 0000–0051 and their snapshots remain untouched.

## Installation and compatibility

The migration fixes its transaction-local search path to public/pg_catalog and refuses any existing public allocation parent, child or denial function. This includes a complete matching historical candidate installation. It never adopts, repairs, drops or overwrites those objects. An operator encountering `S08_ALLOCATION_PREEXISTING_OBJECTS` must stop for a separate reconciliation plan. The old candidate SQL remains a historical fixture, not a second installer.

Fresh installation and upgrade use Drizzle's transaction. Parent/child creation, constraints, function, guards and migration journal entry commit together or roll back. A repeated successful migration is skipped by the journal. An injected failure after all new DDL leaves neither allocation object nor migration entry; retrying the original SQL succeeds.

Both tables deny INSERT, UPDATE, DELETE and TRUNCATE unconditionally through statement triggers. PUBLIC receives no table privilege or function EXECUTE capability. No application role, grant-scoped append function, flag override, enabled writer, route, queue or provider adapter is added. The schema uses lossless bigint mappings; it does not widen existing int4 saga amounts or authorize out-of-range transfers between components.

Installing both tables makes the existing inert saga require a complete matching allocation for new attempts. Historical intents without evidence fail closed with `ALLOCATION_REQUIRED`; no backfill fabricates a freeze. Existing attempts replay using their original identity after upgrade and reject replacement keys. The original shared lock, expiry, envelope and recovery tests now exercise migrated storage.

Existing positive saga/reconciliation tests receive canonical synthetic allocation evidence from an explicitly scratch-only fixture. That fixture requires a unique `echogrid_s08_` database and its existing privileged replication-mode connection. It runs neither a provider operation nor an authorized append path. The previous schema guard test now verifies installed guards and rolls back its synthetic business, rather than installing/rolling back candidate DDL. No assertion or financial guard is relaxed. Two existing scratch migration launchers use Node directly for Windows/Linux compatibility.

## Acceptance evidence

Local environment: pinned pnpm 11.9.0, native Windows Node 24.16.0, and a new WSL PostgreSQL 16.15 cluster on loopback port 55464. Its data directory is `/tmp/echogrid-s08-0052-20261102/data`; it contains only synthetic test databases. No Neon, staging, production or live Stripe resource is used.

The 27 new PostgreSQL migration cases cover fresh replay and exact SQL hashes; populated upgrade and no-op replay; parent-only, child-only, both incompatible tables, existing function and complete old candidate rejection; failure after DDL followed by clean retry; eight owner mutation denials; actual restricted-role permissions, ownership/replication denials and trigger enforcement even after accidental DML grants; eight shape/false-authority checks; tenant FKs, RESTRICT deletion, reservation/provider-key uniqueness, positive child amounts and lossless bigint storage; legacy new-attempt refusal and original-attempt replay. Fresh and upgraded catalogs compare columns/defaults, constraints, indexes and guard definitions/enabled states.

Before/after checks verify the five required economic guards enabled: `partner_credit_ledger_insert_disabled`, `partner_credit_lots_inert_guard`, `partner_credit_reservations_inert_guard`, `pc_multiunit_allocation_inert_guard`, `pc_multiunit_movement_inert_guard`. Existing allocation transactional tests retain their scratch-only guard disabling; production protections are never changed.

The first invocation ran before the disposable server started: a Unix socket permission error prevented migration/testing. After setting a task-owned socket location, replay succeeded. The first valid focused run was 78/80: two new tests expected a TRUNCATE trigger error but PostgreSQL rejected parent-only truncation at the FK boundary first. The assertions now include both tables so the denial trigger is reached. The three selected denial cases passed, followed by all 80 then-current focused cases. The added old-candidate test is verified separately and in the final 27-case migration run; the 54 existing focused cases plus those 27 form 81 distinct cases, without double counting reruns.

The HETA storage verifier passed 44 checks. API source/test typechecks, targeted lint, migration drift and old-table snapshot parity passed. Published CI results and exact final totals are recorded in the PR, separately from these local runs. Local Windows verification is focused; the full integration suite and isolated award run are verified by Linux CI.

## Remaining boundaries

The ordinary-role tests prove the permissions constructed in disposable PostgreSQL, not the identity or grants of any deployed application role and not production RLS. The synthetic fixtures do not authenticate an invoice or certify append authorization. Hashes establish integrity, not historical completeness or provider success. Both authority flags remain false.

The full provider account/mode/customer/subscription binding, grant-scoped append contract, destination amount validation, global economic lock order, multi-reservation versus one-unit terminal application conflict, detailed tax/settlement evidence and final consumption/compensation accounting remain gated by the persistence contract and frozen Split 06/07/08/HETA sources. No financial contract is changed, no existing saga `consumed` state is reinterpreted as a ledger movement, and no historical-tier gate is bypassed.

This is a draft migration PR for review, not permission to deploy it. Retain all protected migrations and economic guards. No financial activation, Stripe call, issuance/redemption, settlement, deployment or merge. Stop after this block for owner and architecture review.
