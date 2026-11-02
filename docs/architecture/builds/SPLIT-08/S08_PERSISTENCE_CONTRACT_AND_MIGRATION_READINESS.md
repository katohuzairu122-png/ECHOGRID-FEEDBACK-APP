# S08 persistence contract and migration-readiness review

Date: 2026-11-02. Status: proposed development contract; documentation only. Owner and architecture approval are outstanding. No migration, writer, deployment or economic activation is authorized by this document.

## Baseline and governing sources

Reviewed authoritative main at `3f6427798fbd6ccf6aa2370806472e7ff894773a`, the merge of PR #191. PR #190 supplied reservation-first serialization, full stored-envelope verification and a final locked expiry check. PR #191 supplied interrupted-transaction and expired-attempt recovery tests. Their passing component tests do not establish provider authenticity or production privileges.

This review reconciles:

- [S08-DEV-04 allocation and canonical digest](S08_DEV_04_AGGREGATE_ALLOCATION.md).
- [S08-PIC/1](PROVIDER_INTEGRATION_CONTRACT_S08_PIC_1.md), [component coverage and owner decisions](S08_PIC_1_COMPONENT_COVERAGE_AND_OWNER_DECISIONS.md), and the development-only [draft timing](OWNER_DECISION_S08_DRAFT_INVOICE_TIMING_2026-10-25.md) and [negative Invoice Item](OWNER_DECISION_S08_NEGATIVE_INVOICE_ITEM_2026-10-25.md) decisions.
- [Reservation/application ownership](CE1_RESERVATION_TERMINAL_APPLICATION_SOURCE_OF_TRUTH.md) and [typed inert persistence gates](CE1_TYPED_PERSISTENCE_ATOMIC_RESERVATION_GATE.md).
- [PR #181 remediation](S08_PR181_REMEDIATION_2026-11-02.md) and [DEV-08 recovery verification](S08_DEV_08_RECOVERY_REPLAY_VERIFICATION.md).

Source paths in the following sections are relative to the repository root. Existing frozen contracts take precedence. Proposed requirements below cannot silently change them.

## Observed implementation and enforcement

| Source                                                                                                                | Current evidence                                                                                                                                            | Limit                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/scripts/sql/s08-allocation-freeze.candidate.sql`                                                            | Two allocation tables, relational tenant keys, uniqueness, positive amounts, false authority flags and statement-level INSERT/UPDATE/DELETE/TRUNCATE denial | Candidate SQL only; absent from the migration journal and typed schema. No restricted append capability exists.                                                             |
| `apps/api/drizzle/meta/_journal.json`                                                                                 | Last entry is index 51, `0051_heta_g_persisted_reconciliation`; 52 recorded migrations                                                                      | No migration `0052` exists at this baseline. A passing drift check does not cover unmodeled candidate SQL.                                                                  |
| `apps/api/src/billing/allocation-freeze.transaction.ts`                                                               | Canonical batch reservation locks; attempt exclusion; atomic parent/children; full relational/JSON verification; final server-clock expiry check            | Development writer requires test-only guard disabling. No invoice authentication, provider account binding or production append authorization.                              |
| `apps/api/src/billing/stored-allocation-verifier.ts`                                                                  | Recomputes canonical artifact and compares parent plus ordered children; rejects mismatches; literal false authority flags                                  | Without an independent source, reconstruction proves internal consistency only. A digest is not a signature or HETA certificate.                                            |
| `apps/api/src/billing/benefit-application.saga.service.ts`                                                            | New attempt locks reservation then intent; installed allocation storage requires matching complete evidence; partial installation denies                    | With both allocation tables absent, legacy inert behavior remains. Installing both tables changes new-attempt behavior; replay does not retroactively require a new freeze. |
| `apps/api/drizzle/0048_split08_benefit_application_saga.sql` and `apps/api/src/db/schema/benefit-application-saga.ts` | Saga intents are mutable projections; attempts, observations, compensations and transitions have append-only protections as well as inert guards            | Saga `consumed` and compensation records are declarative reconciliation state, not Partner Credit movements.                                                                |
| `apps/api/drizzle/0049_split08_benefit_reconciliation_attempts.sql`                                                   | Reconciliation attempt identity is immutable; completion is restricted after an outcome is present; delete/truncate denied                                  | This bounded completion record must not be mislabeled as wholly insert-only. No production role or permission evidence was collected.                                       |

The candidate uses `CREATE TABLE IF NOT EXISTS` but unconditionally creates triggers. It is not a repeatable installer or compatibility validator for pre-existing objects. Copying it into a migration would not establish safe adoption of an existing candidate table.

## Proposed persistence contract

### Identity, ownership and trust

Split 06 owns source settlement consent/acceptance and reversals. Split 07 owns award decisions, accounts, lots, recovery obligations and credit movements. Split 08 owns invoice eligibility, allocation evidence, application reconciliation and billing history. Allocation persistence must never grant financial authority to another domain.

The existing batch identity is `(business_id, invoice_ref)`; its reservation children retain the original distinct invoice-intent references and stable `benefit-apply:v1:<reservationId>` keys. One reservation and one provider key cannot belong to multiple allocation children. A conflicting replay must reject rather than allocate a replacement identity.

A future authorized entry point must resolve authenticated server-side business, provider account, operating mode, customer, subscription, invoice, reservation, intent, policy and operation identity. The candidate does not store that whole binding, and its invoice uniqueness is not scoped by provider account or mode. Before an operational writer, approve either an immutable authenticated binding reference or an explicit scoped schema/key design, including uniqueness and historical compatibility. Do not infer the missing binding from caller JSON, metadata or digest equality, and do not widen existing keys in this review.

Historical subscription interval evidence remains governed by HETA; allocation integrity cannot set `historicalTierVerified`, `issuanceAuthorized` or `redemptionAuthorized`. Both allocation authority flags remain false in storage and returned values.

### Shape and destination limits

The parent retains its immutable ID, business/invoice, currency, policy, digest, aggregate amount, reservation count, full versioned artifact and recorded timestamp. Children retain parent/business/reservation identity, invoice-intent reference, positive monetary share and stable provider key. Preserve composite tenant FKs, RESTRICT deletion and all candidate uniqueness constraints pending explicit review.

S08-AGG-ROUND/1 remains the allocation rule: one aggregate floor; one to ten one-unit reservations; deterministic residual assignment by ascending canonical reservation ID; reject zero shares; exact conservation. Preserve the published positional digest encoding and supported versions.

SQL bigint values must be parsed losslessly and range-checked before JavaScript number conversion. The pure artifact accepts safe integers while existing saga amount columns are int4. Reject values beyond every destination's range before any write; do not silently narrow, round, truncate, drop reservations or expand int4 columns in an unrelated migration.

Current SQL constraints do not prove child count/sum, complete canonical ordering, digest correctness, equality of JSON and relational values, or live invoice authority. The complete guarded transaction must establish these invariants. A future append interface must make partial parents/children uncommittable through any permitted caller path; direct application INSERT permission is insufficient.

### Atomicity, locks, expiry and replay

Allocation creation locks the entire batch of persisted reservations in canonical order, checks exact tenant/intent/state/units and absence of any prior provider attempt, then persists and verifies the complete immutable envelope in one transaction. New attempt creation uses the shared reservation-before-intent order and verifies the installed allocation envelope. Preserve the current final server-clock expiry check while reservation locks are held, immediately before transaction completion; it is not a guarantee about physical WAL commit time.

The future end-to-end writer must also reconcile this local order with the existing settlement/claim, decision/lot, account and recovery-obligation order. This review does not approve a new global order or authorize an economic lock path. Review every writer and reversal/release/finalization path together before activation.

An existing attempt remains recoverable after expiry using its original operation identity. No replacement attempt or key may be created for an unknown outcome. After lost COMMIT acknowledgement, reconnect and inspect persisted identity: absence permits the same requested operation to retry under all current checks; durable matching evidence returns the original record; conflict fails closed. A committed freeze alone does not authorize a new attempt after expiry. Do not convert expiry into permission to release an unresolved provider obligation.

Both allocation tables absent preserves current inert legacy behavior. Exactly one present fails closed. Both present requires complete matching evidence for new attempts. Migration rollout must explicitly account for existing intents without freezes; do not fabricate backfilled invoice evidence or grandfather financial authority. Existing attempt replay must retain its historical identity and evidence.

### Append-only history and supersession

Allocation parents and children are immutable evidence once committed. No UPDATE, DELETE, TRUNCATE, cascade deletion or in-place correction is an application capability. Keep all current denial triggers intact in the current implementation.

If a correction/supersession model is later required, approve an additive design first: retain original records and digest, explicit predecessor reference, reason, actor/service identity, version and server timestamp; prevent ambiguous or cyclic replacements; resolve one effective interpretation without erasing disputed evidence. Current `(business_id, invoice_ref)` and reservation uniqueness deliberately prohibit replacement allocations. This document does not add a supersession table, remove uniqueness or authorize a second provider operation. Quarantine conflicting evidence and require architecture resolution.

Keep attempts, observations, compensations and transitions under their existing immutable-history rules. Intent projection updates and the existing bounded reconciliation completion are exceptions defined by their own contracts; neither permits rewriting economic history. Declarative effects must never be treated as executed ledger or Stripe operations.

### Permissions and append boundary

An inert installation must retain unconditional write denial. A later append capability needs a separately reviewed database-enforced boundary that validates the complete operation, authenticates tenant scope and records audit evidence atomically. Ordinary application roles must lack table ownership, DDL, trigger disabling, replication-mode changes and direct mutation rights; readers must be scoped to the authenticated business. Schema/search-path resolution must be fixed and reviewed, including the current unqualified `to_regclass` lookups.

If a privileged function is proposed, its owner, fixed search path, EXECUTE grants, PUBLIC revocation, argument validation, rollback semantics and audit behavior require explicit review and restricted-role tests. A session flag, application convention or discretionary guard disabling is not an authorization boundary. No such function, role or grant is introduced here. Owner/superuser fixtures cannot certify application RBAC or RLS.

## Migration readiness and blockers

| Gate                                                  | Disposition at reviewed main                      | Evidence needed to close                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development artifact/replay integrity                 | Implemented with component tests                  | Preserve PR #190/#191 regressions and explicit non-authority semantics.                                                                                              |
| Inert allocation migration package                    | Not ready to implement as a direct copy           | Approve typed mappings/export, generated snapshot/journal integration, SQL ownership of custom triggers, namespace and strict pre-existing-object handling.          |
| Fresh install and upgrade compatibility               | Unverified for candidate migration                | Fresh replay and upgrade from exact `0051`; migration hashes, schema/constraints/triggers/index parity, populated synthetic upgrade and transactional failure/retry. |
| Existing intents and absent/partial allocation tables | Behavior identified; rollout unresolved           | Explicit deny/recovery behavior and synthetic compatibility cases without fabricated backfill.                                                                       |
| Restricted append writer and tenant reads             | Not implemented/certified                         | Separate reviewed capability contract, authenticated binding, role tests and immutable audit.                                                                        |
| Amount compatibility                                  | Known safe-integer/bigint/int4 boundary           | Boundary tests at each destination; no unapproved numeric expansion.                                                                                                 |
| Multi-reservation terminal accounting                 | Architecture conflict for operational integration | Existing one-unit terminal application and business/invoice uniqueness must be reconciled by the owner before a multi-credit consumer; do not relax them.            |
| Provider/tax/settlement/accounting                    | Remaining decisions and implementation gates open | Record detailed D1/D3/D4 decisions and authoritative evidence; D2 aggregate allocation is already selected for development.                                          |
| Financial activation/deployment                       | Withheld                                          | Separate explicit owner authorization and complete frozen-domain acceptance evidence.                                                                                |

Migration `0052` is a prospective sequence number only; re-read main and reserve the next available number during separately authorized implementation. Never alter historical migrations or their hashes/snapshots to accommodate this candidate. Preserve migrations 0040–0044, especially 0041/0042/0044 guards, and all later frozen constraints.

The five named economic barriers remain required: `partner_credit_ledger_insert_disabled`, `partner_credit_lots_inert_guard`, `partner_credit_reservations_inert_guard`, `pc_multiunit_allocation_inert_guard`, `pc_multiunit_movement_inert_guard`. Candidate allocation guards and saga append-only/inert guards are additional protections, not substitutes.

## Proposed acceptance work for a separately authorized implementation

1. Generate typed schema/snapshot/journal integration against a pinned main; inspect the complete diff and exact migration hashes. The generated diff must not silently alter existing tables or guards. Verify custom SQL protections independently of Drizzle drift.
2. In disposable PostgreSQL only, replay from empty and upgrade a populated synthetic `0051` database. Test clean absence, parent-only, child-only and pre-existing incompatible candidate objects. Any incompatible adoption must abort transactionally with no partial schema or journal entry. Repeat after injected failure and verify deterministic recovery.
3. With guards enabled, prove denial of INSERT/UPDATE/DELETE/TRUNCATE, false-flag constraints, tenant FK and uniqueness constraints, and immutability. Exercise an actual restricted application role, not only the database owner. Verify all five economic guards plus candidate/saga protections before and after.
4. For any separately approved append capability, prove exact parent/child count and sum, full envelope/digest checks, currency/policy/version and numeric limits, stable operation identity, malformed/missing/conflicting evidence, cross-business denial and rollback of every partial write. No privileged fixture result substitutes for restricted-role authorization.
5. Retain reservation-first concurrency, overlapping batches, conflicting replay, begin-attempt/freeze races, initial and delayed expiry, backend termination and both COMMIT-ack outcomes. Verify old existing-attempt replay after expiry and fail-closed new attempts when evidence is missing or partial.
6. Preserve Split 06 consent/acceptance, Split 07 balances/ledger/holds and HETA gates. Run existing evidence storage verification, migration drift/replay, focused and full PostgreSQL integration, typechecks, lint and applicable CI; record exact counts/skips and avoid double counting isolated suites.

No acceptance step above authorizes live provider execution, Neon/production access, disabling deployed guards, financial writes or migration deployment.

## Review disposition and evidence limits

This change records a proposed persistence contract and a source-based readiness assessment. No new PostgreSQL replay or restricted-role/provider experiment is performed in this documentation block. Prior runtime totals belong to their pinned PRs and are not fresh results for a hypothetical migration.

Fresh post-merge [CI/CD run 723](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/41494328343) completed successfully on the reviewed main SHA. Local validation for this documentation change used pinned pnpm 11.9.0: Prettier passed and the existing migration drift check passed with no generated changes. The new PR's CI and review status are recorded separately in its description. No independent approval is claimed.

Verdict: documentation is reviewable; allocation migration implementation and operational append/financial integration remain blocked by the specific gates above. The next bounded implementation, after contract approval, is typed inert allocation storage with fresh/upgrade migration verification. Keep unconditional guards; operational append and final accounting remain separate blocks. Stop after this documentation PR for owner/architecture review. No approval, merge, deployment, certification or activation is implied.
