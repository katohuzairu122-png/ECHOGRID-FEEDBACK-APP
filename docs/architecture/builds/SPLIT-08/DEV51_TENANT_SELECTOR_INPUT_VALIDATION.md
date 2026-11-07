# DEV-51 — Tenant Selector Input Validation

**Status:** Development-only implementation; CI verification required.

## Baseline
`resolveTenantContext` previously checked that `X-Business-Id` was present but did not bound or syntactically validate either tenant header before using the values in database-backed membership and branch queries.

## Implementation
- Accept opaque alphanumeric, underscore and hyphen identifiers up to 256 characters, compatible with established UUIDs and existing fixture identifiers.
- Reject whitespace, separators, comma-joined duplicate-header values, invalid characters and oversized identifiers **before** opening a database connection.
- Preserve the existing `MISSING_BUSINESS_CONTEXT` outcome when the business header is absent.
- Return `INVALID_BUSINESS_CONTEXT` or `INVALID_BRANCH_CONTEXT` (HTTP 400) for present malformed values.
- **A well-formed selector never grants access**; membership, business usability, branch ownership and effective permissions remain independently enforced.

## Tests and boundaries
`tenant-context.test.ts` adds malformed and oversized tenant-header cases asserting no membership, business, branch or permission query is invoked. Valid UUID selectors continue through the existing path.

No route layout, session/token, data, migration, settlement or deployment changes.

**Verification:** Confirm final exact-head hosted API typecheck and tests before owner review.
