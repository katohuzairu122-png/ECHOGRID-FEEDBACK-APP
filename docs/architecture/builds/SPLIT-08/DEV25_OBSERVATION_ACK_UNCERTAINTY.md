# ECHO GRID — DEV-25 Observation Acknowledgement Uncertainty

**Status:** development-only test harness. No merge, deployment, financial activation or operational provisioning authorized.

## Authoritative baseline

- PR #248 (DEV-24) merged as `543244bea2302e2df9e300b25c708fac83a232de`.
- DEV-23 observation contract carries **only** status, fixed event name and `financialAuthorization: 'NOT_GRANTED'`.
- DEV-24 implements a bounded in-memory, non-durable test sink, never an operational audit log.

## Threat model and finding

A sink can accept a record and then lose the success acknowledgement. A caller receiving an error cannot distinguish **not committed** from **committed but unacknowledged**. Retrying status-only events can yield duplicates. Status-only events carry no unique key or correlation identity, so the existing observation shape offers no exactly-once or event-level deduplication guarantee. A success callback does not independently certify durable commit.

The existing DEV-23 wrapper correctly returns `UNAVAILABLE` when `sink.record` throws. DEV-25 proves both the before-record and after-record failure modes, preserving fail-closed behavior even when a stored observation might exist. It does not invent a deduplication token, reconstruct customer identifiers or upgrade the observation into financial authority.

## Implementation

A new disposable-only one-shot fault-injection sink wraps the existing `PrivateProvenanceObservationSink` interface. `BEFORE_RECORD` fails before the downstream append; `AFTER_RECORD` awaits downstream acknowledgement and then throws; `NONE` passes through. The planned mode is consumed before awaits to avoid accidental repetition on concurrent calls. No operational singleton, adapter registration, storage migration, route, queue, timer, network access or DB grants.

## Verification requirements

- Unit: before-record failure (nothing appended); after-record failure (append present despite returned error); duplicate after retry; one-shot/concurrent behavior; invalid fault mode and missing sink.
- Disposable PostgreSQL: genuinely signed, trusted custody verification through DEV-22/23/24, lost-ack observation failure returns `UNAVAILABLE`, retry can produce duplicate status-only observations, and no credit or ledger mutations.
- Run lint, typechecks, unit suites, PostgreSQL migrations/integration, isolated concurrency, builds, browser tests, static security checks and hosted exact-head CI before reporting merge readiness.

## Owner architecture decisions — NOT resolved by DEV-25

1. Whether observation events need independent per-verification identity, correlation, tenant scope or privacy-preserving pseudonymization for reconciliation.
2. Durable backend, atomic append/ack semantics, deduplication and retention/erasure policy.
3. Who may provision dedicated auditor identities, observe outcomes, retry, export and access records, with independent security/privacy review.

No durable or financial action can be enabled until separately approved. D4 and R10 remain unchanged. No automatic merge, deployment or DEV-26.
