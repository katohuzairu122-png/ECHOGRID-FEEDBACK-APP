# Group 10 — DEV-74–76: bounded customer history reads

Authorization: **development only**. Baseline main: `44eaab8f33a3754c0b10cea1476b28a8e1bbc9c9` (Group 9 merged).

## Evidence and scope
Two authenticated, customer-owned history endpoints returned unbounded database result sets: `GET /surveys/participations` and `GET /consent`. These already filter by authenticated customer ID; no tenant permissions are changed.

- **DEV-74:** Survey participation list accepts canonical `limit` and `offset` parameters, using the existing fail-closed `parseListPagination` validator. Limit 1–100, offset 0–1,000,000; defaults 100/0. Reject invalid and duplicate parameters with the existing `INVALID_PAGINATION` contract before database access.
- **DEV-75:** Consent grant customer history receives the same validation and limits. Existing consent grant creation, revocation, and active-check semantics remain intact.
- **DEV-76:** Deterministic descending history ordering by creation/grant timestamp and UUID tie-breaker for both lists, preserving customer ownership filters.

The JSON response remains an array; explicit `limit` and `offset` enable navigation. Previously unbounded default lists now return at most 100 records per request; callers requiring more must page. This is an intentional backwards-compatibility consideration for client review.

## Evidence required before merge
Run full exact-head GitHub CI, including TypeScript, tests, lint, migration/integration suites, web builds and browser checks. Independently review customer-facing consumers to ensure pagination is supported or adjust scope before merge.

## Exclusions
No changes to QR economic authority, redemption, loyalty accounts, ledgers, billing, provider calls, RLS, schema, migrations or deployment. No automatic merge.