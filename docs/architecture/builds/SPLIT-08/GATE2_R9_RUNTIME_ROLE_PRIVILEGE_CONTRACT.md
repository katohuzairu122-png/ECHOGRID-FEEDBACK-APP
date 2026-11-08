# Gate 2 R9 — Dedicated Runtime Role & Privilege Contract

**VERDICT: DESIGN / NEGATIVE-CAPABILITY CI ONLY. LIVE STAGING IS BLOCKED.**

## Observed security baseline, 2026-11-08

- Cloudflare staging Hyperdrive `fdf777957ac54455aca7ecaa1f12f5bf` shows `User = neondb_owner`, database `neondb`, Neon pooled endpoint `ep-sparkling-hall-au6p04ch-pooler.c-10.us-east-1.aws.neon.tech`, and caching disabled (owner-provided Cloudflare screenshot).
- Live Neon staging project `echo-grid-staging` (`lucky-glitter-47218268`), default branch `br-bold-water-aukjlvw3`, has PostgreSQL 18.6, 45/67 migrations, 69 public ordinary tables, zero enabled/forced RLS; its `neondb_owner` login has BYPASSRLS, CREATEROLE and CREATEDB.
- Existing financial migrations `0061`–`0066` define dedicated NOLOGIN function-owner, verifier, reader, recorder and auditor roles and FORCE RLS, **but those migrations have not been applied to staging**. They must not be granted indiscriminately to a general app login.
- This document does not assert that the pooled endpoint's precise Neon project identity has been independently confirmed by Cloudflare API; the console host is consistent with the staging project region/endpoint.

## Target role architecture (not a provisioning authorization)

1. Separate **migration/ownership role** from **Cloudflare/Hyperdrive app runtime login**. Never connect the public Worker through `neondb_owner` after controlled migration and cutover.
2. Runtime login **must** be LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION and must have no membership in the Neon owner, financial lifecycle/function-owner, financial auditor or authority-grant roles. Avoid elevated PUBLIC defaults.
3. Grant only explicit schema USAGE, table/column and sequence rights required for an independently reviewed application operation. No blanket `GRANT ALL ON ALL TABLES`, schema CREATE or ownership. Default-deny new tables/functions/privileges; review SECURITY DEFINER functions individually and set protected search_path.
4. A runtime identity with SELECT on `businesses`, `branches`, `feedback`, `surveys`, or `loyalty_accounts` is **NOT currently certifiable as tenant-isolated by PostgreSQL** unless RLS policies are designed and verified for those tables; repository application filters are not a replacement for direct SQL isolation. No new RLS behavior is authorized in R9.
5. Distinguish staff, customer/public QR, platform administration and background worker trust boundaries before granting database privileges. Confirm how `echogrid.tenant_id` is set/reset per pooled connection and whether transaction-local context exists for every applicable request. Do not infer user isolation from a single global Hyperdrive login.
6. Preserve existing Partner Credit write-denial triggers, ledger isolation, signed evidence custody, disabled provider reads and no financial authorization. No financial role memberships or function EXECUTE authority for the provisional runtime login.
7. Before any live role/Hyperdrive cutover: finish owner-approved protected staging-copy 45→67 upgrade and restore drill; complete tenant-table RLS policy design, least-privilege grants for each workload, hostile cross-tenant testing against nonowner connections, Cloudflare staging secret/binding identity verification, rollback plan, owner approval.

## R9 automated verification

The isolated PR-only workflow replays **67 committed migrations on a fresh disposable PostgreSQL 18 container**, creates a temporary candidate LOGIN `gate2_r9_disposable_candidate` and proves that:
- It is nonowner, non-BYPASSRLS, has no high-privilege flags or memberships.
- It can connect and use public schema, but receives **no direct CRUD privileges on public tables, no public sequence grants, no schema CREATE**, and no ability to execute selected sensitive financial functions.
- Five major tenant tables are currently not RLS-protected; selected sensitive settlement/evidence tables have FORCE RLS after full migration replay.
- It explicitly emits `certification: BLOCKED` and `candidateCanServeApplication: false`. A PASS for negative-capability checks is **not an application readiness PASS**.

**R9 does not create a usable application role in staging, apply migrations, modify Hyperdrive or initiate deployment.** No auto-merge, settlement, Partner Credit economics, or customer onboarding.
