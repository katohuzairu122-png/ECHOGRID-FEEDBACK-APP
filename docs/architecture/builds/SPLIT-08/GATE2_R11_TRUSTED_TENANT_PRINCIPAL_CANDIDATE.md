# Gate 2 R11 — Database-authenticated tenant principal candidate

**DEVELOPMENT / DISPOSABLE CI ONLY — NOT A DEPLOYABLE RUNTIME DESIGN.**

## Context
- Based on authoritative main `cdb4d09fe976d1f5d418d9c9c4359a34a63282d9`; R10 PR #305 is open and independently passing CI, **not merged**.
- R10 proves that `set_config('echogrid.tenant_id',...)` is spoofable by a shared PostgreSQL login. A FORCE RLS predicate referencing only that custom GUC is not an independent authorization boundary.
- Live Echo Grid staging Hyperdrive currently connects as `neondb_owner`, which has BYPASSRLS. No changes to that connection are authorized.

## Candidate R11 — one DB-authenticated login per tenant
Disposable PostgreSQL 18 only:
1. Two nonowner, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOREPLICATION login roles plus an unmapped login.
2. An owner-only `gate2_r11.login_tenants` table that binds `session_user` (the real authenticated login) to one business UUID. Never accept an untrusted tenant header, custom GUC or client-supplied business UUID as authoritative.
3. A narrowly scoped SECURITY DEFINER read function `gate2_r11.trusted_business_id()`: fixed search_path, reads exactly that mapping using `session_user`, with explicit EXECUTE grants; application logins cannot read or modify the mapping, create schema objects, or switch to another tenant role.
4. FORCE RLS and SELECT-only grants on five nonfinancial tables `businesses`, `branches`, `feedback`, `surveys`, `loyalty_accounts`, **only in the disposable database**. Business selectors are `businesses.id` or `business_id`; platform-owned surveys with NULL `business_id` remain inaccessible.
5. Exercise own-tenant rows, foreign-tenant invisibility, absent mapping denial, tampered custom GUC resistance, transaction reset, role impersonation failures, no INSERT/UPDATE/DELETE.
6. No real financial rows, privilege memberships, provider access, Stripe, Partner Credit, migrations beyond existing 67, live staging data or customer onboarding.

## Why a green R11 is still NOT production-ready
- Cloudflare Hyperdrive currently uses one configured database credential per connection configuration. Per-business DB identities imply separately managed credentials/configurations or a new trusted broker; this is **not established as feasible or scalable** for the existing Worker architecture. Do not route tenants into a shared Hyperdrive connection and pretend `session_user` changes.
- A single trusted gateway login per application workload must not be given unrestricted direct table access; it requires a separately reviewed authorization interface with database-verifiable caller claims, constrained SECURITY DEFINER routines and proven control of arbitrary SQL/connection pooling.
- The candidate proves only SELECT isolation on five tables; required INSERT/UPDATE/DELETE/WITH CHECK, transaction boundaries, public QR input, global customers, platform surveys, background jobs, staff role/branch policies and all downstream tenant tables need independent architecture decisions.
- The owner-created mapping is a trust anchor. Role provisioning/revocation, credential lifecycle, tenant creation/deletion, resource limits, ownership and audit requirements remain unresolved. Default PostgreSQL PUBLIC functions/grants require review before any actual role receives access.
- The test asserts that ordinary logins cannot SET ROLE/SET SESSION AUTHORIZATION to a peer. It does not certify a deployed Cloudflare Worker or Neon environment.

## Owner decision gate
This block is a **technical feasibility proof**, not a decision to adopt per-tenant PostgreSQL accounts. Before implementing a deployable runtime role, compare: (A) per-tenant DB principals with Hyperdrive scaling; (B) a highly constrained trusted data-access broker that does not expose arbitrary SQL; (C) database-validated, unforgeable signed actor/tenant assertions with carefully scoped functions and replay protection. Document precise multi-tenant staff/public flows, account recovery, revocation and zero cross-business disclosure, then select architecture explicitly.

**Prohibitions:** No live Neon role/schema/database changes, Cloudflare credential updates, staged data migration, deployment, PR auto-merge, economic activation, or production access.
