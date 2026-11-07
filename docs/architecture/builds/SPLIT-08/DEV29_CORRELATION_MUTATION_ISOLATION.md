# DEV-29 — Correlation Mutation and Isolation Regression

**Authorization:** development-only, test-only. No production wiring, persistence, network, Stripe provider, authorization, financial movement, migrations, or deployment.

## Dependency and baseline

DEV-28 PR #252 is merged. DEV-29 PR #253 targets authoritative main; require exact-head CI and independent review before owner merge.

## Verification scope

- Ensure correlation snapshots attempt fields instead of retaining mutable caller objects.
- Ensure interleaved synthetic sequences do not contaminate one another.
- Ensure ended tokens are invalid, and capacity is reusable only with fresh opaque identity.
- Ensure failed append or foreign token cannot corrupt an active sequence.
- Ensure classifications are immutable and explicitly deny financial authorization, durable proof and exactly-once guarantees.

These tests validate only disposable in-process behavior. They do not establish custody, settlement, signed evidence, tenant authority, idempotency, durable storage, or exactly-once delivery.

## Gates

Review the PR diff and exact-head CI, then obtain independent security/architecture review before owner merge. Do not auto-merge, deploy or advance to DEV-30.
