# S08-DEV-08 — Recovery and replay verification

Date: 2026-11-02. Test-only development block; no economic or activation authority.

## Entry gate and scope

The owner requested the next block conditional on the previous one passing. Merged PR #190 is on main at `ee8313e9eb7080d961b6ed0b168cc302c6c8c0b8`; its post-merge push CI [41465309962](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/41465309962) completed successfully against that exact SHA. No previously approved DEV-08 implementation contract was found. This bounded verification block closes review note R190-01 and exercises documented recovery gaps without selecting unresolved invoice, tax, provider or accounting policy.

Only the existing PostgreSQL integration suite and this verification document change. No application code, production recovery executor, migration, candidate DDL, schema/journal, configuration, dependency, provider adapter, role, guard or financial policy changes.

## Failure-boundary assertions

| Scenario                                              | Required result                                                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing attempt replay after reservation expiry      | Same intent and attempt remain; no replacement operation. An unreachable observation retains the obligation for reconciliation. A different attempt key is rejected. |
| Backend termination after parent insert               | PostgreSQL rolls back the parent; no child persists. Fresh-connection retry creates exactly one complete allocation.                                                 |
| Backend termination after child insert                | Parent and child both roll back; fresh retry creates one complete allocation.                                                                                        |
| Backend termination after attempt insert              | Attempt, intent transition and audit transition roll back together. The previously committed freeze survives. Retry starts the original operation once.              |
| Transport failure before sending freeze COMMIT        | Closing the connection rolls back uncommitted storage; retry creates one complete allocation, not a replay.                                                          |
| Lost freeze acknowledgement after real server COMMIT  | The caller receives an error but complete storage exists; reconnect returns the same durable ID and digest as a replay, without duplicate children.                  |
| Lost attempt acknowledgement after real server COMMIT | The original attempt remains durable; reconnect replays its original key, rejects a replacement key and records no second non-replay begin transition.               |
| Committed freeze followed by expiry before recovery   | Stored evidence remains unchanged, but neither a new freeze nor a new attempt is authorized. No attempt persists.                                                    |

Every successful freeze/replay still reports `providerVerified=false` and `consumptionAuthorized=false`. Persisted evidence is integrity/correlation only, never invoice authenticity or permission to affect a financial record.

## Isolation and interpretation

Tests use a new local disposable PostgreSQL 16.15 cluster on loopback port 55463, with its data directory checked before use. They migrate and drop unique `echogrid_s08_freeze_*` scratch databases. Existing synthetic fixtures use transaction-local replication mode; candidate/saga guards are disabled only in that unique scratch database to exercise inert development code. No persistent or production guard is disabled.

Backend interruption uses `pg_terminate_backend` only after matching a PID obtained from a suite-owned connection to the exact unique scratch database and excluding the control connection. The helper waits for backend exit before asserting rollback and reconnecting. This is actual PostgreSQL backend termination, not an application-process kill or a whole-server restart.

Lost acknowledgements are injected at the driver's transaction boundary. The after-COMMIT case first executes a real PostgreSQL COMMIT and then throws a simulated transport error. The before-COMMIT case ends the connection without sending COMMIT. These deliberately cover both durable outcomes, but do not claim a physical TCP fault injector, production network behavior, distributed exactly-once execution, or actual provider recovery.

Existing guard, tenant, digest, canonical allocation, attempt-binding, expiry and rollback regressions remain in the same suite. Counts for focused and full suites overlap and must not be added twice. Exact local and published CI results are recorded in the PR after execution.

## Local execution evidence

Pinned pnpm 11.9.0 and PostgreSQL 16.15. Clean replay applied 52 migrations; all 52 database migration hashes exactly match repository SQL. The existing HETA verifier passed 44 checks, and all five required economic guards remained enabled in the base database.

The first focused run discovered 29 cases: 28 passed and one new assertion failed because Drizzle wraps an injected COMMIT failure in a query error. The assertion now verifies the original injected error through its cause, without changing application behavior or weakening any persistence assertion. That case passed in isolation (the other 27 cases were deliberately filtered), then the full two-file run passed **29/29**, zero failed or skipped. The eight new cases are included in that total, not additional to it. API source/test typechecking, targeted lint and migration drift checks passed. Final exact-head CI and review status are recorded on the PR.

## Stop and remaining gates

No Stripe calls, provider writes, financial activation, issuance, redemption, credit consumption, settlement, deployment or merge. Candidate storage remains outside migrations and inert by default. Historical-tier authorization, Split 06 consent, Split 07 accounting/dispute holds, Split 08 provider reconciliation and migrations 0041/0042/0044 remain unchanged.

This block does not approve migration 0052, production roles/RLS, an append-only production writer, live invoice/draft authority, tax/settlement rules, an automatic retry executor or later financial integration. Those require their own recorded contracts and owner authorization. Separate review and explicit merge approval remain required. Stop after the verification PR; do not advance automatically.
