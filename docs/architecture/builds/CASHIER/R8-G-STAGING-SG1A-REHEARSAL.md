# R8-G-STAGING-SG1A: isolated Neon migration rehearsal (2026-11-20)

Status: **REHEARSAL COMPLETE; SG1B (the real staging migration) NOT AUTHORIZED AND NOT RUN.** All writes went to one new Neon branch. The existing staging branch, the production project, Hyperdrive, Workers, secrets and DNS were not modified (verified, section 7). The rehearsal branch is preserved for Owner review.

## 1. Identities (independently verified before and after)

| Item | Value |
|---|---|
| `main` | `f594bc99661d9bb07218938bb4477db844353b77` (#542 merged); journal 87 (0000-0086); no open PRs |
| Neon project | `lucky-glitter-47218268` (`echo-grid-staging`), PostgreSQL 18.7. The real production project `divine-voice-54333763` was never contacted |
| Source branch | `br-bold-water-aukjlvw3` (named `production` inside the staging project; default, protected) |
| Source state at branch time | ledger 84 (last = 0083), 118 public tables, 0 triggers on `audit_log`, no 0084-0086 objects, 3 customers, 514 audit rows, LSN `0/B38D3A8` |
| **Rehearsal branch** | `br-withered-forest-aus6cdii` `r8g-sg1a-migration-rehearsal-2026-11-20`, created 2026-11-20T17:54:57Z, parent LSN `0/B38D638`, non-default, unprotected |
| Rehearsal compute | `ep-solitary-cake-aud6g5yf` (separate from the staging compute `ep-sparkling-hall-au6p04ch`, which is what the staging Hyperdrive origin uses), 0.25-1 CU, auto-suspend 300 s. Not bound to any Hyperdrive or Worker |

Isolation proof: the Hyperdrive origin host is the source compute's pooled host, not the rehearsal compute; Neon roles are per branch (`list_postgres_roles` showed the rehearsal branch's new roles and the source branch's role list unchanged); every migration call carried an explicit branch id **and** compute id, and began with a precondition assertion (expected ledger and absent objects) that would abort the transaction.

## 2. Method and its limits (read this before trusting "applied")

The sandbox cannot reach Neon over the database protocol, so migrations were executed **through the Neon SQL tool, not through `drizzle-kit migrate` or the `migrate-staging` workflow**. Each migration ran as one transaction (as `neondb_owner`, the same principal as the production/staging migrator), statement by statement as split by the Drizzle breakpoints, with the ledger row inserted at the end (`hash` = SHA-256 of the migration file, `created_at` = journal `when`; the format was confirmed against the existing 0083 row). Pure comment lines between statements were not sent; comments inside function bodies were. Because transcription is not the real runner, fidelity was **proved by catalog comparison** against the full 0000-0086 chain on local PostgreSQL 16 (section 4). **The real `migrate-staging` path (STAGING_DATABASE_URL, Drizzle) is therefore NOT rehearsed**; SG1B must use it.

| Migration | SHA-256 (first 16) | Statements | Result |
|---|---|---|---|
| 0084 | `214f59c4ca3a5475` | 30 | applied; ledger 85 |
| 0085 | `60ffb13a689192c1` | 6 | applied; ledger 86 |
| 0086 | `0052cc0f716de20f` | 105 | applied; ledger 87 |

Final: ledger **87**, 87 distinct hashes, rows 85-87 match the files, 124 public tables, no failure, no manual patch.

## 3. Neon role-management compatibility (the open question from the preflight): RESOLVED, compatible

- `neondb_owner` (non-superuser, member of `neon_superuser`) created the four NOLOGIN privacy/erasure roles with safe attributes. Each ends with `ADMIN`-only membership (`inherit=false, set=false`), identical to the CREATEROLE-only local rehearsal.
- The temporary membership and schema-CREATE grants used for the cross-owner `GRANT EXECUTE` were revoked by the migration (`has_schema_privilege(owner, public, CREATE)` = false). The migrator can neither execute the privacy functions nor assume the roles.
- Function ownership transfers and SECURITY DEFINER (fixed `search_path`) behaved as designed.
- Neon-specific: a role created with SQL appears in the branch's role list as `no_login` until a password is set; resetting a role's password through the Neon API requires an existing password. For the rehearsal an ephemeral password was set with `ALTER ROLE` on the rehearsal branch only. **This credential exists only on the rehearsal branch and dies with it; it was never printed in a report or committed.**

## 4. Fidelity evidence (rehearsal branch versus local full chain)

| Object class | Local PG16 | Neon PG18 | Match |
|---|---|---|---|
| Functions (27: 0084/0085/0086 and guards), full definitions | md5 `c68debc6...` | md5 `c68debc6...` | identical |
| Triggers (76) incl. enabled state | `83975965...` | `83975965...` | identical |
| Columns of the 8 touched tables (116) | `2a99ad7b...` | `2a99ad7b...` | identical |
| Indexes (14) | `6797aaea...` | `6797aaea...` | identical |
| Constraints excluding NOT NULL (62) | `7939174e...` | `7939174e...` | identical (PG18 also stores NOT NULL as constraints; expected difference) |
| ACLs | | | same apart from the owner name and PG17+'s `m` (MAINTAIN) privilege; local carries an unrelated test role |

## 5. Security results on the rehearsal branch

**Audit immutability (real PostgreSQL, owner and restricted login):** UPDATE, DELETE and TRUNCATE on `audit_log` denied by the 0085 guard even for `neondb_owner` (`AUDIT_LOG_IMMUTABLE`, `AUDIT_LOG_TRUNCATE_DENIED`); the 514 original rows are byte-identical (fingerprint `5185751a...` before and after).

**Restricted runtime role** (script from `main`, applied on the rehearsal branch; the SQL-created LOGIN is a member of the NOLOGIN group only):
- No `neon_superuser`, no BYPASSRLS, no CREATEROLE/CREATEDB/REPLICATION, owns nothing, no schema or database CREATE, no column-level extras, no usable role other than the group.
- Effective privileges (282 table verbs, 8 sequence verbs, 2 PUBLIC-executable functions) are **identical to the local set that the committed verification SQL passes with zero rows**. (The 16 KB verification SQL itself was not re-typed onto Neon; this parity check replaces it and is recorded as such.)
- All 106 RUNTIME tables are SELECT-able (checked in the database as the login); the 18 NO_ACCESS tables are not.
- **Attacks as the real LOGIN (all denied, SQLSTATE 42501 unless noted):** DDL (`permission denied for schema public`), audit UPDATE/DELETE/TRUNCATE (privilege), `TRUNCATE customers CASCADE`, drop and disable the audit trigger and change ownership (`must be owner`), `SET ROLE` to the migrator and to the erasure owner, `CREATE ROLE`, `GRANT ALL ... TO self` (accepted silently and gained nothing: privileges re-checked), `row_security = off` against a forced-RLS table, writing the migration ledger (`permission denied for schema drizzle`), executing the 0084 erasure and 0086 anonymization functions, reading the privacy and settlement tables, `session_replication_role`, `ALTER SYSTEM`, `search_path = pg_temp, public` then audit UPDATE, granting the runtime role to another role.
- **Migrator-level guards (as `neondb_owner`):** `privacy_anonymize_customer` not executable; direct `anonymized_at` update refused (`CUSTOMER_ANONYMIZATION_RESTRICTED`); `TRUNCATE customers CASCADE` refused (`CUSTOMER_IDENTITY_TRUNCATE_DENIED`); a forged non-submitted privacy request refused (`PRIVACY_REQUEST_MUST_START_SUBMITTED`). No customer was anonymized, no request or hold or policy exists, no operator membership was granted (the privacy workflow was not exercised: that would require activating the operator role, which is not authorized).

**Positive and concurrency:** audit INSERT as the login succeeded (one probe row); four parallel INSERT sessions all committed; a transaction whose second statement failed left zero rows (rollback). Probe rows (5 `sg1a.*` audit rows) remain on the rehearsal branch only and cannot be removed (the table is immutable by design).

## 6. Application compatibility: what this did and did not prove

NOT RUN against the branch: the application, Workers, queue and cron handlers, Stripe, cashier and customer flows (the sandbox cannot connect, and no Worker may be bound to the branch). The application evidence is the earlier local suites under the same role definition (1579/0/36 under the restricted login on PostgreSQL 16), which this rehearsal supports by proving the **schema, functions, triggers and the effective privilege set are identical on Neon PostgreSQL 18**. PostgreSQL 18 behaviour of the application is covered only by the hosted PG18 gates. A live smoke test is part of SG6.

## 7. Non-interference (re-verified after the rehearsal)

Source staging branch: ledger 84 (last timestamp unchanged), 118 tables, 0 triggers on `audit_log`, no new roles or functions, 3 customers, 514 audit rows with identical fingerprint, same compute, role list unchanged. Hyperdrive configs (staging and production): `modified_on` values unchanged, same origin user and host. Production Neon project: not contacted. No Worker, secret or DNS operation.

## 8. Resource handling

The rehearsal branch and compute remain (not deleted, suspended or promoted). The compute auto-suspends after 300 s idle (0.25-1 CU); idle cost is storage only. Cleanup (Owner action): delete branch `br-withered-forest-aus6cdii`, which also removes its roles and the ephemeral password.

## 9. SG1B plan (not authorized): migrate the existing staging branch

Prerequisites: a fresh staging restore point (snapshot or restore-drill branch of `br-bold-water-aukjlvw3`); exact Owner approval of the 0084-0086 bundle at a named `main` SHA with green exact-head CI; a decision on the staging application (the deployed revision `fe9c5e897` predates 0084-0086; **the migration is additive and the old application keeps running** because new columns are nullable and nothing is enabled, but this is not tested: confirm with a staging smoke test, then redeploy a current build under SG5); confirm what login `STAGING_DATABASE_URL` uses (names only, never values) and that it is `neondb_owner`.

Execution: dispatch the existing `migrate-staging` workflow with the reviewed SHA and `MIGRATE_STAGING`; expect ledger 84 to 87 and no error; then run the same checks as sections 3-5 (read-only catalog fingerprint, audit immutability, no operator members). Failure handling: Drizzle's PostgreSQL migrator applies pending migrations in a single transaction (not re-verified here), so a failure should leave the ledger at 84; do not hand-patch; restore from the restore point only as a last resort.

Rollback: there is no down-migration; forward fixes only. The additive changes are harmless to the old application.

## 10. Remaining limits

The real Drizzle runner on Neon is not rehearsed; the Neon-side verification SQL is a parity check; application behaviour on PostgreSQL 18 and live traffic are not verified; Owner gates SG1B-SG6 and the policy items D1, D2, D3, D6, R1-R8 remain open.
