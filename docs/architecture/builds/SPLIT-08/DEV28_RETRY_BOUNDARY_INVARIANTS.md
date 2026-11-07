# DEV-28 — Retry Classification Boundary Invariants

**Status:** development-only tests. No runtime, financial, persistence, Stripe, route, database migration, deployment, or provisioning changes.

## Dependency

DEV-27 PR #251 has merged. DEV-28 PR #252 is now targeted at authoritative main. Exact-head CI and independent review remain required before owner merge.

## Scope

- Exhaustively enumerate valid two-attempt synthetic histories with bounded visible counts.
- Verify each result retains `financialAuthorization: NOT_GRANTED`, `durableProof: false`, and `exactlyOnce: false`.
- Reject invalid attempt metadata, contradictory visible counts, nonintegers, unsafe numbers, and disallowed identifiers.
- Exercise 1,000-attempt maximum, rejected overflow and nonmutation after invalid attempts.
- Exercise invalid correlation capacities, cross-harness tokens and stale tokens.

The test oracle is the DEV-26 published classification contract; this does not independently establish durable storage or exactly-once delivery. Synthetic visible counts are not signed custody evidence, authorization, an audit record or proof of financial settlement.

## Review gates

Require exact-head CI, security/architecture review and reconciliation to authoritative main before owner merge. No auto-merge, deployment or DEV-29 advancement.
