# BDPN-01B part 2 — profile permissions (implementation record)

**Status: IMPLEMENTED — VALIDATION PENDING (draft PR). Development only. No route uses these permissions yet, no migration, no schema, no UI. Nothing has been seeded or backfilled in any shared environment.**

- Baseline: `origin/main` @ `07ee2837698aa03d641f916499b7900c234ceac0`. Independent of the storage block (#505) and of part 1 (#507): it needs no tables.
- Implements: `BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` section 6.1 (decisions D-02 and D-03).

## 1. What changed

| Change | Where |
| --- | --- |
| Business permissions `profile:edit` and `profile:submit` added to the permission catalog | `apps/api/src/db/seed/permissions.seed.ts` |
| Granted to **Owner and Admin only** in the default role definitions (Manager and Staff get neither) | `apps/api/src/rbac/role-provisioning.service.ts` |
| Same grants mirrored in the one-time backfill script for **existing** businesses' roles (script changed, **not executed**) | `apps/api/src/db/seed/role-permissions-backfill.seed.ts` |
| Code-owned platform permission `profile:moderate`: only the platform `admin` role holds it, `support` and `billing` hold nothing, it is not stored in the database and no business role can obtain it; an unknown or missing role fails closed with a 403 | `apps/api/src/platform/business-profile-permissions.ts` |
| Tests | `business-profile-permissions.test.ts` (platform matrix and middleware), `dc1-authorization-matrix.test.ts` (default role grants), `test/integration/business-profile-permissions.integration.test.ts` (real Postgres) |

## 2. Behaviour

- `profile:edit` and `profile:submit` are business-wide permissions. A user holding the Admin role **only at a branch** resolves neither without a trusted branch context, so a branch-limited user cannot change or publish what the public sees (verified against real Postgres).
- `profile:moderate` never appears in the permission catalog or in any business role's resolved keys (verified).
- The middleware reads the platform role already resolved by the platform authentication chain; separation of duties (reviewer is not the submitter) stays in the database (BDPN-01A) and in the later transition service.

## 3. Rollout steps that are NOT done here (each needs separate authorization)

1. `db:seed` in an environment to add the two catalog entries (CI does this for its ephemeral database).
2. `db:backfill-role-permissions` to grant the two keys to **existing** businesses' Owner and Admin roles. Until it runs, existing businesses' roles lack the keys; new businesses get them automatically.
3. No route, service or UI consumes the permissions yet (BDPN-01B part 3 and later).

## 4. Verification

API typecheck passes; the new and changed files lint clean (only the two existing `no-console` warnings in seed scripts); the API unit suite passes (230 files, 3,651 tests); the new integration test passes 7 of 7 against a local PostgreSQL 16 after seeding. Hosted CI: see the PR.
