# DEV-52 — Tenant Isolation Security Regression Matrix

**Status:** Development-only tests; CI verification required.

## Baseline and test objective
Existing tests assert selected membership and foreign-branch cases but do not cover cross-request permission isolation alongside permission and branch middleware. DEV-52 tests the complete staff tenant-resolution and authorization middleware chain with a controlled in-memory repository fixture.

## Added regression scenarios
1. Business A permissions never grant Business B access on a separate request.
2. A nonmember cannot discover business state; membership denial comes before status and permissions.
3. A suspended member's business is refused before effective permissions are resolved.
4. A business-wide user supplying a foreign branch header is denied before permissions.
5. A branch-scoped user cannot select another branch.
6. A branch-scoped user must provide a matching authorized branch context.
7. A branch-scoped user cannot perform business-wide mutations.
8. A business-wide user still needs the target business's own write permission.

## Boundaries
Tests do not change production behavior, route registration, financial permissions, persisted data, RLS, provider calls or settlement state. The test fixture supplies an authenticated user ID; it tests authorization middleware and does not replace end-to-end JWT or database-RLS verification.

**Verification:** Confirm exact-head hosted API test suite, typechecks, integration tests and build before merging; retain as draft until fully verified.
