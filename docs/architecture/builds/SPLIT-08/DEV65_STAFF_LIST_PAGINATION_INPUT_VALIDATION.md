# DEV-65 — Staff List Pagination Input Boundaries

**Authorization:** Development only. No migration, release or production access.

## Verified baseline gap
Staff `GET /messaging/conversations` and `GET /notifications` parsed `limit` and `offset` using `Number(raw) || undefined`. This silently accepted empty/zero values as defaults and permitted negative, fractional, nonfinite, oversized and duplicated selectors to reach repository queries.

## Implementation
- A pure shared `parseListPagination` parser validates present query values as canonical unsigned decimal safe integers.
- Notification lists retain their existing 200-item repository ceiling; messaging lists retain their existing 1000-item default/ceiling.
- The offset is bounded to 1,000,000 to avoid unbounded offset scans and database integer issues.
- Missing parameters remain absent, preserving repository defaults.
- Invalid or duplicate values fail with HTTP 400 `INVALID_PAGINATION` before a database connection is opened.
- Pure unit tests cover allowed defaults/caps, duplicate parameters, fractions, nonfinite values, unsafe integers and malformed encodings.

## Boundary
The new validation applies only to two identified staff list endpoints. It does not change route authorization, membership checks, customer-facing lists, repository sort orders, data access or financial state.

**Verification:** Exact-head CI and independent owner review required before merge.
