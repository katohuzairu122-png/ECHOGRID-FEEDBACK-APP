# Gate 2 — Post-Rehearsal Runtime and Database Privilege Read-Only Audit

**Date:** 2026-11-09. **Status: BLOCKED for runtime certification and original staging cutover.** Evidence-only, no database writes, new roles, Hyperdrive changes, secrets, deployment, or merge.

## Exact scope

- GitHub main at audit: `1562ec6e4c32e3d71c5b098230d1d250f01b623f`.
- Neon staging project `lucky-glitter-47218268`, isolated migration rehearsal branch `br-wild-mode-aur6fpp8`; PostgreSQL 18.6, `neondb`, 67/67 migrations.
- Default staging branch `br-bold-water-aukjlvw3` remains a distinct branch with 45/67 at the last completed migration verification. Neither branch was modified by this audit.
- Inspectors used Neon read-only SQL/catalog metadata and GitHub configuration. Actual Cloudflare Hyperdrive metadata was **not** freshly read: the connected browser context was unavailable, and no Cloudflare account connector was available.

## Confirmed controls

- Five critical financial/evidence relations `partner_credit_settlement_authorizations`, `stripe_read_authorizations`, `signed_evidence_records`, `signed_evidence_events` and `settlement_custody_authorization_links` have ENABLE/FORCE RLS and dedicated policies.
- Protected-table `PUBLIC SELECT` is not granted; unrestricted `PUBLIC EXECUTE` was not present on 22 inspected `SECURITY DEFINER` functions. PUBLIC does not have CREATE privilege on `public` or `drizzle` schemas.
- Named settlement, Stripe-read and signed-evidence database group roles are NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE. No dedicated restricted **LOGIN** runtime principal was created or certified.
- Five original financial inert guards plus the new custody guard remained enabled in the prior post-migration verification. No economic feature was activated.

## Blocking effective privilege findings

1. **The current available application-compatible login is `neondb_owner`**. It has `LOGIN`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`, and membership in `neon_superuser` and named migration-created groups. It can SELECT protected tables regardless of RLS. Neither catalog policy presence nor a `SET ROLE` experiment would certify a Worker connecting as this owner.
2. Ordinary application tables `businesses`, `branches`, `customers`, `feedback`, `loyalty_accounts`, `surveys`, `users`, `refresh_tokens`, and `partner_credit_ledger` have **no RLS enabled**. There are no PUBLIC SELECT grants on these inspected tables; nonetheless an owner/BYPASSRLS runtime credential with application SQL access can read cross-tenant data.
3. `settlement_auth_tenant_select` and `read_auth_tenant_select` policies use `current_setting('echogrid.tenant_id', true)`, which an ordinary SQL client can set. This is a scoped read selector, **not** an independently authenticated actor/tenant binding. Do not treat it as a robust boundary for a pooled shared login.
4. Several SECURITY DEFINER functions have fixed `search_path=pg_catalog, public`, while `partner_credit_settlement_auth_check` and `partner_credit_ledger_settlement_gate` use `search_path=public, pg_catalog`. PUBLIC CREATE in public is currently denied, but the public-first function resolution must receive independent qualified-object/security review before privileged invocation.
5. Source `apps/api/src/db/client.ts` creates a `pg.Client` using `hyperdrive.connectionString` directly. There is no distinct per-tenant login at this layer.
6. Historical 2026-11-08 audit in `GATE2_R9_RUNTIME_ROLE_PRIVILEGE_CONTRACT.md` reported staging Cloudflare Hyperdrive `fdf777957ac54455aca7ecaa1f12f5bf` as `neondb_owner` (based on an owner-supplied screenshot). This remains **historical**, not fresh Cloudflare configuration attestation. Actual live credentials/environment targets must be independently rechecked.
7. `.github/workflows/migrate-staging.yml` accesses the hidden `STAGING_DATABASE_URL` secret, uses exact main SHA and manual `MIGRATE_STAGING`, but neither repository code nor read-only Neon inventory proves that secret is pointed at the correct branch or that GitHub staging environment reviewers/branch restrictions are enabled.

## Why certification cannot proceed automatically

The only available Neon branch LOGIN is a privileged owner (plus internal `cloud_admin` and `neon_service` logins). The newly created domain roles are NOLOGIN. Executing adversarial tenant tests under the owner would **not** prove nonowner isolation; creating a new LOGIN runtime role, changing grants, or rotating Hyperdrive secrets is an architecture/security mutation outside this read-only gate.

Cloudflare UI inspection could not be completed because the browser connector requires a separately connected originating browser context. No Cloudflare credential was requested or displayed.

## Required next security steps — separate owner-governed blocks

1. Confirm current Cloudflare Hyperdrive ID, associated Neon branch endpoint, database name, **username only** (never password), binding environment and Cloudflare Worker deployment identity; read-only.
2. Obtain owner decision on deployable tenant-safe database access architecture. Per-tenant login R11 remains a disposable proof; shared connection with spoofable GUC is insufficient. Evaluate a restricted broker with database-verifiable, issuer-bound assertions and no arbitrary table SQL access.
3. Design and independently verify a restricted LOGIN or broker role (NOBYPASSRLS, NOCREATEDB, NOCREATEROLE) in **another disposable/isolated** environment with isolated credentials. Check runtime SQL and SECURITY DEFINER grants, signed assertions, replay, revocation, failure handling and pooled request isolation.
4. Verify effective nonowner tenant isolation for ordinary business tables, branch access, global customers, surveys, anonymous QR and staff flows. RLS coverage is not equivalent to a simple migration flag: domain policies need deliberate approval.
5. Independently prove GitHub staging environment restriction, credentials separation, backup retention and restore acceptance before authorizing the default branch migration.
6. A separate owner decision is required to apply 0045–0066 to default staging. Migration rehearsal PASS does not override the runtime-blocking findings.

**Verdict: DATABASE SCHEMA/CATALOG CHECKS PASS; RUNTIME ROLE ISOLATION NOT CERTIFIED; ORIGINAL STAGING MIGRATION NOT AUTHORIZED.**
