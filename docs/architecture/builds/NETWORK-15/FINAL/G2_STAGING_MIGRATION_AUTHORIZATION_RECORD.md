# G2 — exact-target staging migration authorization record (0088 + 0089)

**NOT EXECUTED. NOT AUTHORIZED.** This record is prepared for the Owner. Nothing here migrates, deploys or activates anything.
Prepared 2026-11-25 against `main` `1ef2145ffbd46254e8bacacf9634b1c57e477a79`.

## 1. What changed since AR02 (reconciliation)
AR02's checklist assumed 0088 was the **last** pending migration. It is not. The runner applies the **whole pending range**, not one file
(see AR02 `MIGRATION_RELEASE_CHECKLIST.md`). Today the journal is 0000–0089 (90 entries) and 0089 (`customer_deletion_requests`, merged in #576)
was added after AR02. **Approving "0088" alone is therefore impossible with the normal runner: the Owner must approve 0088 AND 0089 together.**
0089 is independent of Community and inert (nothing writes to its table until CUST-DEL-02 ships); it has its own tests (PG16 local, PG18 hosted CI).

## 2. Read-only target observations (2026-11-25, Neon SQL read-only queries)
| Item | Staging `lucky-glitter-47218268` / `br-bold-water-aukjlvw3` | Production `divine-voice-54333763` / `br-blue-paper-atrcoge1` |
|---|---|---|
| Applied ledger rows | 88 (last journal timestamp `1795250000000` = 0087) | 88 (same) |
| `community_terms_current` present (0088) | no | no |
| `customer_deletion_requests` present (0089) | no | no |
| `community_memberships` rows | 0 | 0 |
| `consent_grants` rows | 3 | 0 |
| `community_point_rules` rows | not read | 0 |
| **Pending range** | **0088 then 0089** | **0088 then 0089** |

Hash comparison of the applied ledger against the journal was **not** repeated here (the staging/production ledgers were last verified when 0084–0086 were applied).
The Owner's release operator must re-run the ordered identity/count/hash comparison immediately before authorization (AR02 rule: `verify-production-migrations.mjs` success alone is not an exact-prefix attestation).

## 3. Reviewed migration manifest (SHA-256, first 16 hex)
| idx | tag | `when` | sha256 |
|---|---|---|---|
| 87 (applied) | `0087_customer_pending_registration` | 1795250000000 | `fab77c0dbab7628a` |
| 88 (pending) | `0088_community_membership_consent` | 1795422498513 | `2a9dd536afacd36b` |
| 89 (pending) | `0089_customer_deletion_requests` | 1795559456815 | `3ce8df8edd63f6a3` |

## 4. Risk assessment of the pending range
- **0088** creates two empty terms tables and their guards; swaps two CHECK constraints (`community_memberships_status_check`, `consent_grants_purpose_check`) and adds one partial unique index. It does **not** backfill, delete or rewrite any row. Both affected tables are tiny at the targets (0 memberships; 3 or 0 consents), so constraint validation and index creation are effectively instantaneous; a lock-budget measurement under representative load is not needed at this size but must be re-confirmed if row counts change before the run.
- **0089** creates one new table with a guard trigger and indexes; no existing table is altered.
- Both are additive and forward-only. There is no down-migration. Recovery = forward fix; a snapshot/restore point is the last resort.
- The currently deployed API (`b62d8c8`, 2026-11-24) already probes for the 0088 tables before using them (`to_regclass`), and does not read the 0089 table, so the old app keeps working before and after the migration. **Not proven live**; re-verify on staging.
- Runtime role: both manifests add SELECT-only access for the terms tables and INSERT/SELECT/UPDATE (cancel-only, trigger-guarded) for deletion requests. The runtime-role cutover (R8-G SG2–SG4) is a **separate, unapproved** workstream; today the API still connects as `neondb_owner`.

## 4a. Evidence available (stated precisely)
- **PostgreSQL 16:** the full chain 0000–0089 applies from empty (local and hosted `ci-cd.yml`, which uses `postgres:16`); the full API integration suite passed locally (1710 passed, 41 skipped) and hosted CI on #576 (27/27).
- **PostgreSQL 18, migration chain:** the hosted `gate2-pg18-*` jobs replay the **full journal** with `db:migrate` on `postgres:18` at every PR head, which includes 0088 and 0089 (#576 head `41b123e`: those jobs passed). AR02 additionally ran a populated 0087→0088 upgrade on PG16.16 and PG18.7 with ten table fingerprints preserved.
- **PostgreSQL 18, Community integration suites:** **not** run by any pre-existing hosted job (the Community/Network integration suites ran on PG16 only). This readiness PR adds the disposable workflow `community-pg18-acceptance.yml` to run them, and the real-Chromium journeys, on `postgres:18`; its result is in the certificate. Until it is green, this gap stays open.
- Earlier text in #576's description ("full chain on PG18") meant the migration replay only; it did not mean the integration suites ran on PG18.

## 5. Preconditions the Owner must satisfy before the run
1. A fresh staging restore point (snapshot or restore-drill branch) of `br-bold-water-aukjlvw3`.
2. A named executor and a named approver (not the same person where policy requires).
3. `main` tip at approval time recorded; the protected `migrate-staging` workflow dispatched with `MIGRATE_STAGING` for that exact SHA.
4. Re-run of the ordered ledger/hash comparison (section 2) with no gap or unexpected timestamp.

## 6. Owner approval block (all blank by design)
| Field | Value |
|---|---|
| Target | staging `lucky-glitter-47218268` / `br-bold-water-aukjlvw3` |
| Approved range | 0088 and 0089 together (YES / NO) |
| Approved `main` SHA | ______ |
| Executor / approver names | ______ / ______ |
| Restore point id | ______ |
| Date/time and signature | ______ |

Production requires a **separate** record with fresh evidence; staging approval does not carry over.

## 7. Post-migration verification (read-only, after the run)
Ledger = 90 rows with the three hashes above; `community_terms_publications` and `community_terms_current` exist, both empty; no publication is current (`community_terms_current.publication_id` is null); `customer_deletion_requests` exists and is empty; `audit_log` fingerprint unchanged; all four `COMMUNITY_MEMBERSHIP_*_ENABLED` and `NETWORK_FEED_ENABLED` still unset on every Worker; no membership or consent row changed.
