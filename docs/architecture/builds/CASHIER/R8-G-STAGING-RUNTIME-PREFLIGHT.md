# R8-G-STAGING-01: staging runtime-security preflight (2026-11-20)

Status: **PREFLIGHT ONLY. NOTHING IN STAGING OR PRODUCTION WAS CHANGED.** Live inspection was read-only (Neon catalog reads, Cloudflare listings, GitHub reads). Technical readiness here is not deployment authorization. No cutover was performed, so **no staging runtime acceptance is claimed.**

**Verdict: staging cutover is NO-GO today (BLOCKED on schema).** Staging is at migration 0083; the runtime-role manifest and the application on `main` expect 0086. The runtime-role work itself is technically ready for the staged sequence below once SG1 is authorized.

## 1. Verified live identities (read-only)

| Item | Finding | How verified |
|---|---|---|
| `main` | `16dbd10885d5cd8e745674caaf7bd4459b9b9ed7` (#541), journal 87 (0000-0086); no open PRs | git, GitHub REST |
| Neon staging project | `lucky-glitter-47218268` (`echo-grid-staging`), PostgreSQL **18.7**, aws-us-east-1 | Neon describe |
| Staging database branch | `br-bold-water-aukjlvw3`, named **`production`** inside the staging project (default, protected). Not to be confused with the real production project `divine-voice-54333763` | Neon list branches |
| Compute | `ep-sparkling-hall-au6p04ch`, active, read-write; pooled host `...-pooler` (PgBouncer, transaction mode) | Neon computes |
| Hyperdrive (staging) | `echo-grid-feedback-staging` id `fdf777957ac54455aca7ecaa1f12f5bf`, origin host = that compute's **pooled** host, db `neondb`, origin user **`neondb_owner`**, origin connection limit 20, caching disabled | Cloudflare config read (no password is returned) |
| Hyperdrive (production) | `echo-grid-feedback-db`, user `neondb_owner` (identity reference only) | same |
| Workers (personal Cloudflare account `cf2052...`) | `echo-grid-feedback-api-staging`, `...-web-staging`, `...-cashier-staging` (modified 2026-11-19 04:46); also the two production Workers | Cloudflare list. The INFINICUS account holds no Hyperdrive and no Echo Grid Worker |
| Staging deployed revision | last `deploy-staging` and last `migrate-staging` runs: workflow_dispatch of `fe9c5e897` on 2026-11-19 (04:44 / 04:13); both success. `main` is now 16 commits ahead (158 app files) | GitHub Actions runs |
| Staging principal in use | **`neondb_owner`**, a non-superuser with CREATEROLE and BYPASSRLS (via `neon_superuser`) that owns every table. A live session of that user (via the pooler) was observed. The Hyperdrive config binds that same user | role inventory + Hyperdrive config + pg_stat_activity |

Not verifiable with the available tools: the exact Worker revision ids, Worker-binding-to-Hyperdrive wiring as deployed (I read the repository `wrangler.toml` instead), and Worker secrets (names or values). Method for the Owner: `wrangler deployments list --name <worker>` and `wrangler hyperdrive get <id>` (neither prints a password).

## 2. Staging schema versus `main` (matrix)

| Group | Staging | Note |
|---|---|---|
| 0000-0083 | **APPLIED** (ledger 84; last row's timestamp equals journal 0083 exactly; 118 public tables) | includes business profiles/B2B (0080-81), managed cashier identity (0082), onboarding events (0083) |
| 0084 erasure foundation | **PENDING** | no `onboarding_erase*` function, no erasure roles |
| 0085 audit immutability | **PENDING** | `audit_log` has **0 triggers**; staging `audit_log` is mutable today |
| 0086 customer privacy lifecycle | **PENDING** | no `privacy_*` functions or tables, no `customer_privacy_*` roles |

No partial migration was found. 118 tables + 1 (0084) + 5 (0086) = the manifest's 124, so the manifest is consistent with the schema after migration. Existing role set: 5 settlement roles, 4 signed-evidence roles, 5 Stripe-read roles (all NOLOGIN, no bypass), plus Neon system roles; **no** `echogrid_app_runtime`. Existing data: 3 customers, 3 onboarding events, 514 audit rows (nothing in 0084-0086 rewrites or constrains existing rows; rehearsed on a production-shaped dataset: fingerprints identical). **The application revision (`fe9c5e897`) matches its schema (0083)**, but is older than `main`.

## 3. Runtime-role design (reviewed)

`echogrid_app_runtime` is a NOLOGIN group role with safe attributes; an application LOGIN is a member. Provisioning is a generated, idempotent script (not a migration), no secrets, placeholder login name; it verifies rather than alters a pre-existing role (a non-superuser cannot `ALTER ROLE ... NOSUPERUSER`). It is not provisioned anywhere. Effective-privilege matrix for the key tables (manifest, then proven on real PostgreSQL):

| Table(s) | Runtime privileges |
|---|---|
| `audit_log` | INSERT, SELECT (no UPDATE/DELETE/TRUNCATE) |
| `users`, `businesses`, `branches`, `user_business_roles`, `customers`, `business_customer_memberships`, `consent_grants`, `loyalty_accounts`, `loyalty_rewards`, `business_subscriptions`, `subscription_plans`, `orphan_settlements`, `network_posts`, `b2b_participations`, `notifications`, `customer_credentials` | SELECT, INSERT, UPDATE |
| `loyalty_transactions` | SELECT, INSERT, UPDATE (per the manifest's observed verbs; database guards on the ledger still apply) |
| `customer_onboarding_events`, `partner_credit_ledger`, `stripe_provider_events` | SELECT, INSERT |
| `customer_sessions`, `otp_codes` | SELECT, INSERT, UPDATE, DELETE |
| `privacy_requests` and the other 4 privacy tables, `onboarding_erasure_operations`, Stripe-read, settlement and signed-evidence families | **no access** (18 tables NO_ACCESS) |
| migration ledger (`drizzle` schema) | no privileges (schema USAGE is on `public` only) |
| functions | no EXECUTE on any definer function; PUBLIC-executable set pinned to two invoker-rights functions by a CI gate |

## 4. Workload inventory

Only the **API Worker** connects to PostgreSQL (`HYPERDRIVE` binding). The web Worker has no database binding (it calls the API); the cashier surface is served through the web/API. The private Stripe verifier and mail receiver have no database access. All API workloads share the one binding and therefore one principal:

| Workload | Path | Runtime verification |
|---|---|---|
| HTTP routes (auth, cashier, customer, loyalty, community, B2B, billing, platform) | `fetch` | VERIFIED locally under the runtime LOGIN (full suite) |
| Queue consumer: `classify_feedback`, `send_notification`, `escalate_critical_incident` (and `generate_summary`) | `queue()` | **NEW:** first three VERIFIED by calling the real handler as the runtime LOGIN; `generate_summary` calls Anthropic and is NOT run (not exercised; its database access was not separately verified under the runtime) |
| Dead-letter consumer | `queue()` DLQ branch | VERIFIED: runs without a database (deliberately) |
| Cron `*/5`: critical-incident sweep, stale AI-usage sweep, orphan-settlement expiry, Stripe heartbeat | `scheduled()` | **NEW:** VERIFIED (incident enqueue, stale row abandoned, no sweep failure); heartbeat covered by `stripe-evidence-heartbeat` under the runtime (7/7) |
| Cron daily/weekly/monthly: OTP prune, per-business summary enqueue | `scheduled()` | **NEW:** daily VERIFIED (OTP DELETE, enqueue); weekly/monthly share the code |
| Durable Objects (password hasher, email rate limit) | own storage | no PostgreSQL |

Separate specialised roles: the Stripe-read, settlement and signed-evidence families already have dedicated roles; the runtime has no access to them by design. **No evidence was found that the API Worker needs more than one principal.** `generate_summary` and live Workers AI/Anthropic calls cannot be exercised without external services.

## 5. Evidence (disposable PostgreSQL 16; staging is PostgreSQL 18)

Added in this block (tests only; no application code changed): `runtime-workloads.integration.test.ts` (6 tests, real `queue`/`scheduled` handlers, restricted LOGIN via the HYPERDRIVE binding) and the runtime seam wired into four previously uncovered suites (`billing-permissions`, `platform-mrr`, `critical-incident-atomicity`, `stripe-evidence-heartbeat`). Negative controls: revoking one privilege makes the right tests fail with `permission denied` (workloads: 4 of 6; billing/MRR/incident: 14 of 14; notifications: 1). Results on a fresh, seeded database with the full migration chain (0000-0086) and the runtime role provisioned (verification SQL: zero rows): **full integration under the restricted runtime login 1579 passed / 0 failed / 36 skipped (132 files)**; the six new workload tests also pass on the default owner connection; API unit 4105/4105 (260 files); web unit 1227/1227 (156 files); API typecheck clean; `db:check` clean; ESLint clean on the five touched test files. NOT RUN: default-connection full integration on this head (the previous head passed 1573/0/36), web typecheck on this head (no web file changed), R21 selftest (CI-guarded), Chromium scenarios. A defect found in the process: a handler reports cron failures only via `console.error`/ops webhook (swallowed by design), so the tests assert on database effects and on the absence of reported failures.

## 6. Neon- and Hyperdrive-specific findings that change the cutover

1. **The runtime LOGIN must be created with SQL (`CREATE ROLE ... LOGIN`) by the migrator, not through the Neon Console, API or CLI.** Neon documents that roles created there are granted `neon_superuser` membership (CREATEROLE, BYPASSRLS), which would silently give the "restricted" login BYPASSRLS and role-creation power and defeat R8-G. After creation, verify `pg_auth_members` shows no `neon_superuser`.
2. The migrator `neondb_owner` is itself a member of `neon_superuser`. Local rehearsals used a CREATEROLE-only migrator; **Neon-specific behaviour of 0084/0086's temporary role-membership steps is NOT VERIFIED** and is the main reason SG1 must start on a disposable Neon branch.
3. Hyperdrive caches its pool: `wrangler hyperdrive update` changes origin credentials in place without tearing down existing pool connections (restart the pool to drain) and in-place editing makes rollback depend on the old password still being in the secret store. **Recommended: create a NEW Hyperdrive config for the runtime LOGIN and rebind the staging API Worker; keep the old config untouched** (rollback = rebind).
4. The current staging origin is the **pooled** (PgBouncer, transaction-mode) host, and Cloudflare's Neon guide recommends the direct (non-pooled) string for Hyperdrive. Keep the same origin host for the first cutover (change one variable at a time), and record the pooled-versus-direct decision separately. The application uses transaction-scoped advisory locks only, which work in transaction mode; session-level features were not found.
5. Role/password operations on Neon staging touch shared state; none was executed.

## 7. Cutover plan (NOT executed; each gate needs its own Owner authorization)

Order (a role cannot precede the schema it is granted on; the provisioning script skips absent tables, which would silently under-grant):

- **SG1 staging schema migration 0084-0086 (ledger 84 → 87).** First rehearse on a disposable Neon branch of staging (as `neondb_owner`), then the real `migrate-staging` workflow; verify ledger 87, `db:check`, guards present. Prerequisite: a staging restore point (a snapshot or branch; the prior drills used `restore-drill-*` branches).
- **SG2 role provisioning.** As `neondb_owner`: run the generated provisioning, create the application LOGIN by SQL (password from the secret store, never in chat or git), attach it, run `verify-runtime-role.sql` (zero rows), confirm no `neon_superuser` membership and NOBYPASSRLS.
- **SG3 credential.** Store the LOGIN password only in the secret store; no value in repository, logs or reports.
- **SG4 Hyperdrive.** Create a new config for the LOGIN (same host/database); do not edit `echo-grid-feedback-staging`.
- **SG5 Worker deployment.** Deploy a current `main` build with the staging API Worker bound to the new config (the web/cashier Workers keep no database binding). The older `fe9c5e897` application revision has no knowledge of 0084-0086 and must be redeployed after SG1 to match.
- **SG6 live staging acceptance.** Confirm `SELECT current_user` through the Worker path (the pg_stat_activity user for the new pool), run the cashier harness, customer join, billing read/webhook, queue and cron smoke tests, confirm audit INSERT succeeds and mutation is denied, check logs for `permission denied`.

Rollback (bounded): rebind the staging API Worker to the previous Hyperdrive config and redeploy; no data change is involved; the schema stays at its migrated state (forward fixes only). Rolling back is a staging action only and does not authorize restoring owner-level access in production. Keep the old config and owner credential until a soak passes.

## 8. Cutover decision matrix

| Dependency | Status |
|---|---|
| Staging schema | **BLOCKED** (0083; needs 0084-0086) |
| Staging application revision | **BLOCKED** (older than `main`; deploy after SG1) |
| Role provisioning readiness | PASS locally (idempotent, verify-not-alter, non-superuser rehearsed) / NOT VERIFIED on Neon |
| Effective privileges | PASS (zero verification rows; manifest equals held privileges) |
| Hyperdrive compatibility | PASS in design (new config recommended); NOT VERIFIED live |
| Credential handling | PASS in design; NOT EXECUTED |
| API runtime compatibility | PASS locally |
| Cashier / customer compatibility | PASS locally (see report counts) |
| Billing compatibility | PASS locally for repositories, MRR, permissions, Stripe evidence; live Stripe NOT RUN |
| Queue / cron compatibility | PASS locally for 3 job types and both crons; `generate_summary` NOT RUN |
| Audit immutability | PASS locally (migration 0085); live staging has no guard until SG1 |
| Tenant isolation | PASS locally and in hosted gates |
| Security regression tests | PASS locally |
| Rollback readiness | PASS in design; NOT REHEARSED on staging |

## 9. Remaining items

Owner gates SG1-SG6; the unresolved D1, D2, D3, D6, R1-R8 are not affected. Chromium Community scenarios still NOT RUN here; live `generate_summary` NOT RUN; PostgreSQL 18 (staging) versus 16 (local) is covered only by the hosted PG18 gates.
