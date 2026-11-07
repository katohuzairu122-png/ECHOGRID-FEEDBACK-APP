# DEV-26 — Disposable Observation Retry Classification and Correlation

**Scope:** development tests only. No production integration, routes, migration, database role, secrets, Stripe calls, financial mutation, or deployment.

## Baseline and intent

DEV-23 defines a three-field, private, nonfinancial observation. DEV-24 adds a bounded in-memory sink. DEV-25 simulates before-record and after-record acknowledgement faults. DEV-26 introduces a separate in-process classification harness for synthetic retry sequences, without modifying the DEV-23 event schema.

## Contract

- `classifyDevelopmentObservationRetry` consumes only an ordered array of synthetic outcomes and monotonically nondecreasing visible sink counts. It validates exact fields and rejects contradictory transitions.
- `createDevelopmentObservationCorrelationHarness` creates unforgeable in-process Symbol tokens. Tokens are never serialized, persisted, logged, or inserted into observation events. There is no tenant/customer/provider data in the token.
- Acknowledgement loss yields `UNCERTAIN` unless multiple records are independently visible, in which case `DUPLICATE_OBSERVED` is returned.
- The returned result always contains `financialAuthorization: 'NOT_GRANTED'`, `durableProof: false`, and `exactlyOnce: false`.
- The harness is bounded to 1–1000 active sequences and 1–1000 attempts per sequence. No silent eviction.
- Invalid input does not mutate an existing sequence. Ending a token invalidates it.

## Limits

This is **not** an audit store, idempotency key, deduplication mechanism, production retry scheduler, or durable receipt. Symbol correlation does not survive a process restart or coordinate across workers. The classifier sees only test-supplied visible counts; it does not prove an append occurred in a durable database. An ambiguous acknowledgement is never upgraded to a verified durable record. A single visible observation after an ambiguous failure remains `UNCERTAIN` even if a subsequent retry does not append another record.

No change to D4/R10 financial controls or existing custody verification. Operational identifiers, retention, reader authorization, persistence, and revocation atomicity remain owner-gated architecture decisions.

## Review gates

Require exact-head CI, targeted and full tests, architecture/security review, and independent owner review before merge. No automatic merge, deployment or DEV-27 advancement.
