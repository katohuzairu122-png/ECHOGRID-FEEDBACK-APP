# Echo Grid Gate 2 — Isolated Staging Restore-Branch 45→67 Migration Rehearsal

**Date:** 2026-11-09 UTC. **Owner authority:** approved isolated recovery-branch rehearsal only. **Verdict:** **PASS — schema migration rehearsal and catalog integrity**, **NOT** staging cutover certification or a deployment authorization.

## Explicit scope and source

- Source repository: `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`, **pinned commit** `1562ec6e4c32e3d71c5b098230d1d250f01b623f`. Drizzle journal `apps/api/drizzle/meta/_journal.json` had exactly 67 entries, `0000`–`0066`.
- Neon project: `echo-grid-staging` (`lucky-glitter-47218268`), PostgreSQL `18.6`, database `neondb`.
- **Only modified branch:** `br-wild-mode-aur6fpp8`, named `gate2-restore-verification-2026-11-09`, nondefault and nonprimary, restored from snapshot `snap-still-queen-auxustvl`.
- **Untouched staging default branch:** `br-bold-water-aukjlvw3`, named `production` **within the staging Neon project**, verified primary/default before and after. A separate production Neon project was not targeted.

## Method

A controlled branch-specific Neon transaction executor used the actual SQL bytes from the pinned repository's `0045`–`0066` files, in journal order, split only at the exact Drizzle `--> statement-breakpoint` marker. Each migration ran in its **own atomic transaction** with `SET LOCAL statement_timeout = '120s'`, `SET LOCAL lock_timeout = '5s'`, an in-transaction guard on `current_database()`, existing journal count and preceding `created_at`, then an in-transaction journal insertion with source-exact `sha256` hash and committed `when` timestamp. Each transaction was followed by a read-only journal count/last-timestamp assertion before advancing.

Before execution, the database hashing method was independently confirmed against already-applied migration `0044`: source SHA-256 exactly matched the persisted hash. This ensures the 22 new journal entries use Drizzle-compatible hashes. The runner explicitly passed recovery `branch_id` and project ID to every Neon SQL call; neither the production nor shared staging URL was modified.

**Important method distinction:** This executed Drizzle's **migration SQL and exact journal values via branch-pinned transactions**, not the `pnpm db:migrate`/Drizzle CLI process. It is a controlled SQL rehearsal and does not establish that a particular live GitHub Actions migration runner is correctly configured.

All 22 migration transactions completed successfully, `0045`–`0066`, with no stopped or partially recorded migration. The initial check after migration `0045` encountered a transient Neon authentication error; a separate subsequent read confirmed exactly 46 migrations on the recovery branch and 45 on the original before any further migration was attempted.

## Before/after evidence

| Evidence | Restored rehearsal branch before | Rehearsal branch after | Original staging default after |
|---|---:|---:|---:|
| Applied migration journal | 45 | **67** | **45** |
| Public tables | 69 | **98** | **69** |
| Public RLS enabled | 0 | **9** | Previous inventory: 0 |
| Public FORCE RLS | 0 | **9** | Previous inventory: 0 |
| Original financial inert guards enabled | 5 | **5** | **5** |
| New settlement custody guard | Not installed | **Enabled** | Not installed |
| Businesses | 4 | **4** | **4** |
| Branches | 3 | **3** | **3** |
| Refresh-token rows | 15 | **15** | **15** |
| Preexisting first-45 journal timestamp digest | `53777d3c15ca08095e972a3660d6c4df` | Same | Same |

The restored rehearsal branch has no duplicate journal timestamps. The five protected relations `partner_credit_settlement_authorizations`, `stripe_read_authorizations`, `signed_evidence_records`, `signed_evidence_events`, `settlement_custody_authorization_links` exist, with **RLS ENABLE** and **FORCE RLS** set. Their policy counts are respectively 4, 5, 3, 3 and 3. The five original inert guards and new `settlement_custody_link_inert_guard` have `tgenabled = 'O'`.

Role catalog checks confirmed that 14 observed settlement / Stripe read / signed evidence named roles are **NOLOGIN**, **NOSUPERUSER**, **NOBYPASSRLS**, **NOCREATEDB** and **NOCREATEROLE**.

## Incomplete certification and risk

- Database migrations were run through the **owner** `neondb_owner`, which has **BYPASSRLS**. It cannot be used to prove real-world tenant isolation. Existing GitHub workflow, Cloudflare Hyperdrive identity, environment credentials, and nonowner runtime grants **were not used or certified**.
- Catalog/RLS presence and row-count preservation are not an adversarial cross-tenant read/write test. Full database constraints/trigger semantics, Stripe sandbox flows, application E2E, workload key custody, session revocation, signed issuer custody, durable nonce, fail-closed behavior and economic control gates **remain unverified in actual staging**.
- Per-migration transactions do not prove the precise all-or-nothing behavior of a different CI migrator or migration cancellation halfway through the 22-file sequence. Recovery snapshot `snap-still-queen-auxustvl` remains the verified pre-upgrade point; no rollback onto the default branch was attempted.
- The restored branch retains real staging session rows. Keep it isolated; do not connect public traffic, provider webhooks, deployed Cloudflare Workers or production services. Review retention/deletion and snapshot expiry. Neither source nor restore branch is currently marked protected; enforce environment controls before any cutover.
- No customer onboarding, billing/financial activation, deployment, shared secret edit, Hyperdrive cutover, main merge or production action was authorized or performed.

## Required next gate

1. Independent security review of this exact branch, SQL journal, catalog, role grants and protected runtime connection details.
2. Review protected staging GitHub environment, `STAGING_DATABASE_URL` and actual Hyperdrive credentials **without revealing secrets**, ensuring these cannot point accidentally to a wrong project or role.
3. Repeat nonowner RLS and application/integration assertions on an appropriately isolated testing target; verify denial guards and financial controls.
4. Confirm rollback objectives, snapshot retention/restore operation and the approved migration execution/verification workflow.
5. **Separate owner approval** before applying the 22 migrations to the original/default staging branch. No production migration or deployment is implied.

**Rehearsal verdict:** PASS for pinned SQL/journal/catalog checks; **STAGING MIGRATION AUTHORIZATION: NOT GRANTED**.
