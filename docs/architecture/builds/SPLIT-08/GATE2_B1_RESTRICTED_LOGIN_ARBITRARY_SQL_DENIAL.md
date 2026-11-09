# Gate 2 B1 — Restricted LOGIN and Arbitrary SQL Denial Verification

**Date:** 2026-11-09. **Classification:** development-only, GitHub Actions disposable PostgreSQL 18. **No live Neon role, migration, Cloudflare credential or Hyperdrive change, provider effect, deployment, or merge.**

## Baseline and objective

- Started independently from authoritative `main` `1562ec6e4c32e3d71c5b098230d1d250f01b623f`.
- Gate 2's original/default staging remains separate from the migrated recovery branch. This B1 block never connects to either.
- Earlier R9 proved an intentionally unusable LOGIN with no table privileges. Earlier R12 proved a signed synthetic broker. B1 is a **separate, narrower real-SQL privilege exercise**: an ephemeral LOGIN with exactly one restricted, synthetic function and no ordinary table access. It does not copy or supersede R12's signature logic.

## Test mechanism

In a local PostgreSQL 18 GitHub Actions service database **named exactly** `echogrid_ci_pg18_b1_broker`, replay the 67 committed migration files with the pinned project's Drizzle migrator. The B1 script requires `GITHUB_ACTIONS=true`, exact disposable acknowledgement, exact localhost database URL, database name, role and PostgreSQL major version. It cannot run against a live Neon connection without changing code and bypassing explicit guards.

1. Create a synthetic private schema and table, with all PUBLIC grants revoked.
2. Create a single `SECURITY DEFINER` function with a fixed `search_path`, a **constant synthetic fixture read only**, and no actor, business, provider or tenant operation.
3. Explicitly revoke PUBLIC EXECUTE and grant only schema USAGE + function EXECUTE to a temporary LOGIN with `NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, and no memberships.
4. Verify the login can call that fixed function successfully; deny SELECT on real business, customer, feedback, session and signed-evidence tables, and deny direct SELECT/INSERT/UPDATE/DELETE/TRUNCATE on the synthetic private table.
5. Deny CREATE TABLE (public and private schema), CREATE SCHEMA, SET ROLE to database owner, and all SELECT/INSERT/UPDATE/DELETE/TRUNCATE grants across the ordinary public-table inventory. Reject unrestricted PUBLIC sequence privileges and executable existing SECURITY DEFINER functions.
6. Set a fabricated `echogrid.tenant_id` GUC and recheck that arbitrary SQL remains denied. No GUC-only authentication is accepted.

**Not tested:** actor-bound signatures, real customer JWT, key custody, a permitted tenant-specific business read, session revalidation and revocation, durable nonce replay with business effects, Pool/Hyperdrive multiplexing, integrated repository access, or deployed Cloudflare Worker identity. A synthetic fixed broker read is not tenant-safe application authorization.

## Non-negotiable follow-up gates

- **B2:** trusted issuer/verifier cryptography, actor/session/tenant/branch/request/operation binding and key revocation under a limited SQL surface.
- **B3:** atomic nonce consumption and actor/session/tenant revocation serialization together in the real broker transaction.
- **B4:** repository and API changes for first nonfinancial, read-only operations; tenant-safe and provider-specific test gates for business, customer, QR, survey, feedback, loyalty and admin flows. Existing application repositories require direct table SQL; no runtime cutover before their compatible re-architecture.
- **B5:** protected staging role credential provisioning and actual Cloudflare Hyperdrive metadata verification (database username only); independently approved credentials rotation and isolated integration checks, without publishing passwords in PRs.
- **B6:** owner and security approval for role/issuer/Hyperdrive migration, along with operational rollback and an approved staging release plan. The original staging migration remains independently gated.

**Expected verdict:** PASS only if the hosted B1 exact-head test and full CI confirm. The temporary LOGIN is **never** a staging runtime credential.
