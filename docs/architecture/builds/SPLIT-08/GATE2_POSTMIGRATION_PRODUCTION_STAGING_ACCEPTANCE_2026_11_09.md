# Echo Grid — Gate 2 Post-Migration Acceptance Evidence

**2026-11-09 UTC.** Read-only live database inspection and independent development-only classifier. **No deployments, SQL writes, production/staging roles, migrations, Hyperdrive modifications, financial activation, or automatic merge.**

## Verified infrastructure

Main baseline `03988b80e5f1ed7a2c02c514292266e75b1dc045`.

Production Neon project `divine-voice-54333763` branch `br-blue-paper-atrcoge1` and staging Neon project `lucky-glitter-47218268` branch `br-bold-water-aukjlvw3` were inspected using explicit read-only catalog queries.

Both now report 67 Drizzle journal entries with unique timestamps, 9 RLS + FORCE RLS public tables (each with PostgreSQL policies), and 6 enabled inert financial triggers. Both use PostgreSQL 18 and the inspected database connection is `neondb_owner`, with `rolbypassrls=true`. This proves catalog presence and a serious runtime privilege risk; it does **not** prove actual Cloudflare Hyperdrive binding identity at request time or cross-tenant denial. Do not mistake a forced RLS table for effective RLS when a login can bypass it.

The production migration preserved 66 businesses, 20 branches, 69 users and 232 refresh-token rows by post-migration counts. Staging preserved 4 businesses, 3 branches, 16 users and 15 refresh-token rows. These are row-count preservation checks, not complete application or referential-integrity certification.

GitHub exact-head CI was confirmed PASS for B4-06 PR #328 (`83f7e69490f4456f2c9c7d6a2303b43b37e4bbb2`), B4-07 PR #329 (`5118fc2b3c67115b27ef999773628eacaa38b01a`), and B4-08 PR #330 (`c0c9a2fe93781835c4ec65eb3451bc7745cb2677`). At audit time these PRs remained open and independent, not deployed.

## Application trust inspection

- `apps/api/src/db/client.ts`: ordinary API request clients derive SQL connection from `c.env.HYPERDRIVE.connectionString`.
- `apps/api/src/middleware/tenant-context.ts`: user-selected tenant/branch header values are subjected to membership/branch/RBAC checks in application middleware, **not** enforced by a certified limited database login.
- `apps/api/src/branches/branch.routes.ts`: `GET /branches/:id` uses the existing service and the B4-04 broker mode OFF guard.
- B4-03 detached Ed25519 issuer remains development-only, not a certified database broker cryptographic verifier; B4-06 confirms a deny-only disposable PostgreSQL function.

## New offline classification

`gate2-postmigration-acceptance.ts` is a pure evidence classifier, unmounted and non-authorizing. It treats migrated schema as sufficient only for **schema completeness**, never runtime release, onboarding or settlement certification. It explicitly blocks owner BYPASSRLS roles and missing independent credential custody, cross-tenant adversarial tests, exact-session revocation, canonical signature verification and runtime application smoke tests. Tests prove no self-declared green checklist can authorize deployment.

## Remaining mandatory acceptance steps

1. Read-only verify the **actual Cloudflare production/staging Hyperdrive configuration and its bound PostgreSQL role**, separate from the Neon tool's current owner connection. Do not expose credentials in logs or Git.
2. Design, provision and certify a real dedicated nonowner role **in isolated disposable PostgreSQL first**, with no direct tenant-table CRUD and only approved broker operations.
3. Implement the separately authenticated, isolated broker service; prove Ed25519 canonical verification, actor/exact-session/tenant/branch/RBAC authorization at use time and atomic nonce/revocation synchronization.
4. Execute nonowner cross-tenant denial tests on disposable and staging test resources; test pooling swaps, revoked credentials, expired assertions and forced database unavailability.
5. Run explicit application endpoint smoke tests and negative financial-safety tests. Require separate release approval and recorded rollback plan before any traffic/credential cutover.

**Verdict: SCHEMA MIGRATION PASS; RUNTIME/FINANCIAL RELEASE NOT CERTIFIED.** No deployment or cutover authorized by this audit.
