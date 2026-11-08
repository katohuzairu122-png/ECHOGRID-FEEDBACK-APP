# Gate 2 R7 — Authenticated staff request and tenant boundary

**Status:** Development-only regression suite; **no** staging/production proof, merge, deployment, financial activation or migration authorization.

## Baseline
- Created from authoritative main `03b7e38b52118824344592e5541f68a08a93e063`.
- R4 (#300) and R5 (#301) were verified as merged; R6 (#302) was still draft/unmerged.
- R7 is independent of R6.

## What this verifies
R7 composes the **actual** Hono `authenticate`, `resolveTenantContext`, `requireBusinessWideAccess` and `requirePermission` middleware with signed, expiring staff access tokens from the existing JWT implementation. Only database/repository responses are mocked; no middleware authorization rules are replaced.

- Missing or forged bearer tokens reject before tenant membership lookup.
- Verified token identity, not client-provided business headers, determines which memberships may be used.
- Authenticated users A and B must not inherit each other's authorization state between requests.
- A business-wide user cannot select another business's branch.
- Foreign-tenant review actions are rejected before the handler executes.
- Suspended subjects with otherwise valid tokens are denied.
- Effective permissions are recomputed per tenant even if a user has memberships in both.

## Evidence limits
This verifies middleware wiring on test-only Hono routes, **not a live Worker dispatch**, actual feedback/loyalty routes, provider credentials, JWT delivery over a network, or an active Hyperdrive database role. R6 covers selected real-PostgreSQL repository boundaries independently. No customer or business data was copied or altered. R7 is not a certification of the complete operational MVP.

**Gate 2 remains BLOCKED** until live staging authorization, protected environment, backup/restore, tenant-role controls and owner-approved upgrade tests are completed.
