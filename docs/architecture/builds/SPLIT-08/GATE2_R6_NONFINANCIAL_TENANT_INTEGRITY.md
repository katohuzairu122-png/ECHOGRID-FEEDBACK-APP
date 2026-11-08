# Gate 2 R6 — Nonfinancial Two-Tenant Repository Isolation

**Scope:** Development-only tests on disposable CI PostgreSQL. **NOT** live-staging certification.

## Baseline and independence
- Authoritative main on branch creation: `55d761a513272274a74ca40cc3a84a43397a89cb`.
- Gate 2 R4 PR #300 and R5 PR #301 were still open and unmerged at branch creation. This R6 test is independent of both.
- Uses the existing `test:integration` suite and existing CI PostgreSQL database; no new migration, API behavior, production credential, RLS policy or financial writer changes.

## R6 verification matrix
1. Create two independent business tenants and their branches and QR records. Verify a legitimate tenant can read its own branch/QR by ID while the other tenant cannot, even when the UUID is already known. Branch listing excludes the foreign tenant.
2. Insert one ordinary feedback row per business through each business's own branch/QR relationship. Verify scoped reads and cross-tenant status edits cannot reach the other business's row.
3. Create one global customer identity and two separate tenant-owned loyalty accounts with zero points. Verify known-ID and business-list access is tenant-scoped. The global identity is intentional and is **not** tested as a tenant-owned row.
4. Create business-owned surveys in both tenants. Verify known-ID reads, scoped lists and cross-tenant status updates cannot access another tenant's survey.
5. Database access is guarded to local disposable `echogrid_test` / `echogrid_ci_*` names. Test fixtures are synthetic and execute only as part of existing integration CI, never against Neon staging or production.

## Evidence limits
- These are **application repository query boundaries under the CI database owner**, not HTTP route/JWT/Cloudflare Worker authorization or PostgreSQL RLS under the actual Hyperdrive runtime role.
- Financial settlements, Partner Credit issuance, orphan processing and provider read/approval paths are not tested or enabled.
- The suite does not certify tenant isolation of all platform tables; selected nonfinancial repositories only.
- Cross-tenant status updates are expected to return no row, while own-tenant rows retain their existing status.
- An independent review and exact-head hosted CI PASS are required before an owner merge decision. R6 does not authorize migration, deployment, staging clone or customer onboarding.

## Follow-up certification
After R4/R5/R6 are merged by the owner, independently verify the combined main CI and inspect staging runtime database role/permissions, tenant-scoped Worker routes, protected secrets and a separately authorized staging recovery drill. Gate 2 remains BLOCKED until all staging evidence is independently established.
