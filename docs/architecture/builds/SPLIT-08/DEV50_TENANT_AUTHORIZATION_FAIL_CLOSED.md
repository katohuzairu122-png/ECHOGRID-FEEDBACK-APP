# DEV-50 — Fail-Closed Tenant Authorization Guards

**Status:** Development-only implementation; CI verification required.

## Baseline
Staff routes mount `authenticate → resolveTenantContext → requirePermission` and sometimes `requireBusinessWideAccess` or `requireAuthorizedBranchParam`. A guard missing the upstream tenant middleware could encounter an undefined permission set (unexpected 500), instead of explicitly denying authorization. The branch-parameter guard could also compare two missing values.

## Implementation
- Add `assertTenantAuthorizationContext` to require an authenticated user ID, business ID, boolean business-scope flag and permission set.
- For branch-scoped grants, require an established branch ID.
- Call this fail-closed invariant from the staff permission, business-wide, and branch-parameter guards.
- Reject absent required route branch parameters.
- Preserve established tenant membership checks, permission semantics, branch ownership in tenant middleware, and all successful request paths.

## Tests and boundaries
`tenant-authorization-context.test.ts` covers missing upstream context, valid grant paths, missing permission, branch mismatch and business-wide restrictions.
No database, migration, auth-token, role, tenant-status, billing, settlement or production changes.

**Verification:** Confirm final exact-head hosted API typecheck, unit tests and CI before owner review.
