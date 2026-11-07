# ECHO GRID — DEV-24 Bounded Development Observation Sink

Status: DEVELOPMENT ONLY — merge, deployment, operational provisioning and financial activation are not authorized.

## Authoritative baseline
- DEV-23 PR #247 merged to main `bbd56eb7fc62eac540ad8c65018bb4ed35384b13`.
- DEV-24 is an inert, private, test-only companion to DEV-23's injected observation interface.

## Implementation boundary
- A disposable in-memory sink with a hard capacity limit (1–1000) and no operational singleton, production adapter, database connection, network route, queue, schedule or credential.
- Runtime validation enforces the exact three-field observation schema: fixed event, one of four verification statuses, and `financialAuthorization: 'NOT_GRANTED'`. Extra properties and sensitive identifier injection are rejected.
- Each accepted event is cloned and frozen, and the snapshot is a detached frozen copy.
- Capacity exhaustion throws and causes the existing DEV-23 wrapper to return `UNAVAILABLE`. Events are never silently overwritten or dropped as successful observations.
- This is **not durable audit evidence**: process lifetime, crashes and memory limits can destroy these counters; a separate approved durable store and threat model are required before operational use.
- No new financial authority; D4/R10, custody verification, signing key lifecycle, database RLS, legacy authorization treatment and existing customer-facing behavior remain unchanged.

## Tests
- Pure unit cases cover exact schema, sensitive-field rejection, capacity boundaries, mutation isolation, overflow, and concurrent append behavior.
- Disposable PostgreSQL fixture performs genuine signed custody verification via DEV-22/23, observes one valid nonfinancial status, then verifies overflow fails closed, without ledger/credit effects.
- Hosted exact-head CI, security, typechecks, API/web tests, PostgreSQL integration, migrations and builds must pass before owner review.

## Owner controls
No automatic merge or deployment; do not wire the test-only sink into production, cloud storage or external accounts. DEV-25 is not authorized by this block.
