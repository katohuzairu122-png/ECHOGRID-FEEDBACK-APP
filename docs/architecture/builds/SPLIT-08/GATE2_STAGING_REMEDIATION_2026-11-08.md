# ECHO GRID Gate 2 — Controlled Staging Remediation

**Date:** 2026-11-08  
**Status:** DEVELOPMENT/PREFLIGHT ONLY — NO STAGING MIGRATION AUTHORIZATION  
**Repo main assessed:** `5976a0584bf998f403b59fd0ebaa49dc7a9bae4c`

## 1. Directly observed inventory (read-only)

Dedicated Neon project: `echo-grid-staging`, ID `lucky-glitter-47218268`, PostgreSQL **18.6**. Its default branch is misleadingly named `production`, ID `br-bold-water-aukjlvw3`; this branch name does **not** make it the separate production project.

- Database `neondb`, Drizzle migration journal present. **45 applied**, strictly matching journal entries `0000`–`0044` by `created_at`. **22 pending**: `0045`–`0066` of 67 committed migrations.
- Staging `public` catalog has **69 tables** and **zero RLS-enabled tables**. This does **not** imply all legacy tables require RLS; newer migration-specific policies and roles (0061–0066) are not installed.
- Staging has the five legacy disabled-financial-movement guard triggers, all enabled (`O`): `partner_credit_lots_inert_guard`, `partner_credit_ledger_insert_disabled`, `partner_credit_reservations_inert_guard`, `pc_multiunit_allocation_inert_guard`, `pc_multiunit_movement_inert_guard`.
- Newer settlement / signed-evidence roles and named tables absent. `neondb_owner` has `rolbypassrls=true`; do **not** use it to certify tenant-facing isolation. Actual app/Hyperdrive runtime credential and effective grants must be checked separately.
- Neon staging branch unprotected; project reported public connections permitted and no IP allowlist. These facts alone do not establish unauthenticated database access, but require security owner review.
- No automatic snapshot schedule, no listed snapshots, history retention 86,400 seconds. **Backup restore and rollback are unverified.**
- CI #1008 on merged `main` PASSED all standard tests and **disposable PostgreSQL 16** migration replay. This is **not** PostgreSQL 18 staging certification.

## 2. Approved-scope remediation: offline preflight only

`apps/api/src/release/staging-migration-preflight.ts` is a pure decision helper. It compares externally observed migration identities to committed journal identifiers, looks for missing inert triggers, flags unverified security and recovery claims, and **always blocks activation**. It is not connected to deployment or migration workflows.

## 3. REQUIRED BEFORE TEMPORARY DB TESTING

1. Independently confirm staging project and branch IDs, environment secret binding, exact main SHA and owner-controlled `staging` deployment protections. Do not infer anything from the staging branch name.
2. Determine whether staging contains customer or business personal information. **Do not clone an environment with sensitive data into a weaker test area** without approved controls and retention/deletion handling.
3. Choose a **disposable PostgreSQL 18** database under explicit owner-approved scope. An independently seeded empty database is preferable for clean replay. A copy of staging is useful only if data handling, target and deletion are approved.
4. Review migrations 0045–0066 for roles, grants, SUPERUSER / BYPASSRLS behavior, `CREATE EXTENSION`, DDL locks, migration sequencing and non-transactional operations. Do not assume PostgreSQL 16 success proves PG18 compatibility.
5. Establish a verified backup or branch restore point, independent credential boundaries and a tested rollback approach **before any staging update**. Historical migrations may not support automatic down-migration.

## 4. Test protocol — DISPOSABLE DATABASE ONLY (not executed here)

- Pin exact SHA, PostgreSQL version, database host/name and identity; reject `neondb`, default staging branch, any production Neon project, all unrecognized hosts and any connection to shared infrastructure.
- Start with an isolated, empty PostgreSQL 18 database. Replay **all 67 migrations** using the repository's pinned Drizzle tool, then check `drizzle.__drizzle_migrations` for exactly 67 ascending journal identities.
- Check expected least-privilege roles, SQL SECURITY DEFINER function grants and `search_path`, RLS ENABLE/FORCE on specific new tables, triggers, non-TRUNCATE/write-denial rules, and test role-based isolation using **non-owner / non-BYPASSRLS** principals.
- Run API integration and financial invariant tests in that disposable environment. Any test that disables denial triggers or performs provisional awards must run in a **second isolated test database**, never the staging database or tenant data copy.
- On a separately approved staging *clone*, simulate the **45→67 upgrade** to detect existing-data and privilege issues. Record backup point, schema diff, concurrency/lock observations, rollback method and test result. Delete only under the approved retention instructions.
- If the clean replay or 45→67 path fails, stop. Do not apply a partial or speculative migration to staging; submit a new corrective development-only PR.

## 5. Gate 2 — Approval still required to remediate actual staging

**Only after both disposable test paths pass** and backup/restore and tenant-scoped RLS/grant proof is independently reviewed may the owner explicitly authorize an actual staging migration. Use the repository's protected manual staging migration workflow at an approved exact commit. It must not silently deploy, invoke Stripe writes, activate Partner Credits or touch the distinct production project.

After staging upgrade, independently verify against the **actual staging Worker, runtime DB role, Neon catalog and Cloudflare Hyperdrive** that:
- the 67 migration identities are present, protected tables have expected ENABLE/FORCE RLS/policies, and all five legacy guards remain enabled;
- signed-evidence, read-only Stripe authorization and settlement controls still deny unauthorized action;
- staged cross-tenant customer/loyalty/survey/messaging requests cannot read another tenant's records;
- backups and restore drills, monitoring/alerts, rate-limiting, customer journeys and test-mode billing pass.

**Final decision (this report): GATE 2 BLOCKED.** No GitHub merge, staging DB write, migration, snapshot, restore, production deployment, economic activation or customer onboarding was performed.
