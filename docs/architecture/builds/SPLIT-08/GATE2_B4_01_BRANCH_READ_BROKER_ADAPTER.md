# Gate 2 B4-01 — Nonfinancial Branch Read Restricted-Broker Repository Adapter

**Date:** 2026-11-09. **Status:** development-only, dormant contract. **No merge, live role, database migration, credential, Hyperdrive edit or deployment.**

## Independent baseline

- Began from authoritative `main` `19c489ef1db977abc10fa5186ac183c135bcc816` (PR #322 merged).
- Read existing `branches/branch.routes.ts`, `branches/branch.service.ts`, `repositories/branch.repository.ts`, `middleware/tenant-context.ts`, `middleware/authenticate.ts` and existing tests before implementation.
- Exact verified infrastructure mapping: production Neon project `divine-voice-54333763`, branch `br-blue-paper-atrcoge1`, Worker Hyperdrive binding `542dd173d3d14d54ac66c0f1f69e5ff9`; staging Neon project `lucky-glitter-47218268`, original branch `br-bold-water-aukjlvw3`, Worker Hyperdrive binding `fdf777957ac54455aca7ecaa1f12f5bf`. Both Hyperdrives currently use owner `neondb_owner` with `BYPASSRLS`. Never repoint either binding in B4-01.
- Original staging and production remain at 45/67; only the isolated staging recovery branch had a controlled 67/67 rehearsal.

## Code surface

**`apps/api/src/branches/branch-broker-read.contract.ts`** introduces a restricted nonfinancial read adapter for a future broker-mediated **single branch read**. It is not added to `branch.routes.ts`, `branch.service.ts`, the current repositories registry, or any runtime dependency injection. It does not alter existing request routing or privilege behavior.

- Fixed, schema-qualified, parameterized invocation to a **not-installed** prospective `gate2_b4.read_one_branch` SQL function with 13 explicit signed-assertion fields. No arbitrary table SELECT or SQL string concatenation, no tenant-specific SQL assembled from headers and no write operations.
- Assertion syntactic checks enforce required identifiers, operation `branches:read`, nonce, request, bounded timestamp interval and signature hex. These checks are **not** signature verification or proof of actor/tenant authentication. They cannot replace the database-side issuer/verification trust boundary.
- Output is restricted to branch identifier, business identifier, name, slug and status; denies unexpected rows, cross-business results, mismatched branch, invalid fields and any second row. A zero-row broker result maps to `null`.
- Database errors are propagated directly; there is **no fallback** to unrestricted repository SQL.
- Contract tests exercise fixed SQL confinement, output projection, cross-tenant and cross-branch denial, malformed envelopes, multirow response rejection and database denial. These are mock-adapter tests, **not live nonowner isolation tests**.

## Critical exclusions

1. The broker SQL function does **not** exist in default staging or production, and B4-01 must not be routed to or called by any deployed Worker.
2. The test uses a **syntactically shaped signature**, not one verified by trusted key custody. It provides no cryptographic authorization itself; that work remains B2/B3 fixture-only and the real trusted issuer must be independently approved.
3. The current Hono `authenticate` middleware verifies JWT/user state but its access token may omit exact persisted session ID; it must not be used to mint a trusted broker assertion by itself.
4. Current tenant-context middleware obtains a caller-controlled `X-Business-Id` selector and validates membership using owner-login direct SQL. It is **not database-enforced actor identity** or independent tenant proof.
5. Production and staging Hyperdrives use `neondb_owner` and ordinary tables have no RLS; an adapter cannot remediate this without a separate restricted SQL login, audited broker function and complete route/repository trust path.
6. No cross-tenant real database denial, signed issuer custody, pooled-connection safety, revocation atomicity in real application tables, or compatibility of a full branch response shape is certified by this PR.

## Next independently reviewable blocks

- **B4-02**: disposable PostgreSQL 18 function implementing `read_one_branch` against a tenant-scoped fixture, with restricted NOLOGIN role grants and nonowner EXECUTE-only login; prove exact request and membership signature checks, nonce/revocation locking and denial of arbitrary SQL.
- **B4-03**: trusted issuer and effective authorization bridge using independently verified actor/session/tenant/branch membership and read permission, including denial of impersonated/sessionless and anonymous customer substitutions.
- **B4-04**: route/service compatibility and staged nonfinancial read integration behind an explicit OFF-by-default gate with rollback; permission to deploy/activate requires independent security review and owner approval.
- **B5/B6**: runtime credential provisioning, Cloudflare and real isolated Hyperdrive evaluation, cross-tenant penetration tests, release cutover and migration approvals separately. No automatic progression.

**Verdict:** the repository-level restricted broker **contract** is implemented for owner review; live tenant-safe operation and original staging migration remain blocked.
