# Gate 2 R10 — Nonfinancial tenant row access & trust-boundary verification

**Authorization: DEVELOPMENT / DISPOSABLE CI ONLY. Gate 2 stays BLOCKED.**

Baseline: main `cdb4d09fe976d1f5d418d9c9c4359a34a63282d9` (R9 PR #304 merged and successful). No migration, deployed application code, Hyperdrive connection or live Neon role is changed by R10.

## Classification and ownership
| Table | Tenant selector | Intended tenant visibility |
|---|---|---|
| `businesses` | `id` | Exactly the requested verified business |
| `branches` | `business_id` | Branches belonging to that business |
| `feedback` | `business_id` | Feedback for that business only; branch/QR relationships remain separately validated |
| `loyalty_accounts` | `business_id` | Business-scoped account; `customers` is a **global identity** and is excluded |
| `surveys` | `business_id` | Only business-owned survey rows; platform-owned surveys have NULL `business_id` and are excluded |

Downstream survey versions, campaigns, participations, customer privacy, platform admins, anonymous feedback submission, staff authentication, audit/notification tables and all financial settlement/evidence tables require **separate domain policy**. Do not expose via blanket privileges.

## Verified candidate policy — NOT authorized for deployment
On a disposable PostgreSQL 18 Docker service only, the CI script creates synthetic rows for two tenants, enables FORCE ROW LEVEL SECURITY on these **five tables in the disposable database**, grants SELECT only to a nonowner NOBYPASSRLS login, and tests:
- With no tenant context: no rows are visible.
- Under tenant A: one A row per table; B rows excluded.
- Under tenant B: one B row per table; A rows excluded.
- Under the next transaction without a tenant context: zero rows (tests transaction-local reset).
- Direct INSERT/UPDATE/DELETE privileges: refused.
- **Adversarial check:** the same login can call `set_config('echogrid.tenant_id', <other-business-id>, true)` and read another tenant's record. This is a deliberate test that proves an untrusted custom GUC is **not a secure standalone identity assertion**.

A passing R10 workflow must report `policyExercise: PASS` and `stagingCertification: BLOCKED` with `unauthorizedTenantSelectionPossible: true`. This is NOT a security certification that permits a Hyperdrive cutover.

## Required decisions before a deployable role or migrations
1. Define a DB-verifiable **trusted tenant context** that the runtime login cannot forge or widen. A simple session GUC, header, unsigned role claim or arbitrary tenant UUID is insufficient. Investigate a trusted transaction-bound authorization gateway, per-tenant database identity, or tightly scoped SECURITY DEFINER controlled access pattern; evaluate how each handles pooled connections and global customer/public QR flows.
2. Establish that membership, business/branch authorization and actor identities are validated by a trusted component before any row access. Preserve existing API middleware order and tenant-specific role checks; do not assume middleware alone protects a leaked runtime DB credential.
3. Enforce transaction-local context with rollback/reset after each logical operation. Explicitly verify read and write policies, `WITH CHECK`, FK cross-tenant consistency, soft-delete, branch-scoping, and privilege revocation.
4. Design domain-specific handling of platform-owned surveys, shared customer identity and public QR ingestion separately; generic tenant RLS cannot represent these flows.
5. Protect `SECURITY DEFINER` functions, owner privileges and default PUBLIC grants; keep financial/economic subsystems inert and separate.
6. Only after independent architecture approval implement an isolated migration, hostile multi-tenant SQL/HTTP tests with nonowner credentials, and full API regression tests. Then obtain explicit approval for staging-copy migration, backup restore and Hyperdrive cutover.

## Absolute exclusions
No production/staging SQL, Cloudflare change, Neon clone, new migration ledger number, role creation outside disposable CI, merged PR, deployment, credential rotation, settlement read/issuance, Partner Credit economics, or customer onboarding is authorized by this document.
