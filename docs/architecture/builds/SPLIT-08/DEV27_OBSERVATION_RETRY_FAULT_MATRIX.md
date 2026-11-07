# DEV-27 — Synthetic Observation Retry Fault Matrix

**Authorization:** development and tests only. No merge, deployment, financial activation, new migration, production Stripe request, or audit-reader provisioning.

## Dependency

DEV-26 PR #250 has merged. DEV-27 PR #251 has been retargeted to authoritative main. Verify exact-head CI and independent review before merging DEV-27.

## Delivered

The test matrix composes the existing DEV-24 disposable bounded sink and DEV-26 opaque in-process correlation harness, exercising:

- Rejection before append, followed by a successful append.
- Lost acknowledgement after an append, followed by duplicate visible append.
- Successful acknowledgement, followed by a deliberate second append.
- Lost acknowledgement with zero visible records, which stays uncertain.
- Capacity exhaustion, retaining an earlier observation without upgrading ambiguous delivery.
- Separate in-memory sequences and sinks with no cross-sequence visibility.

All observations remain the exact three-field DEV-23 status-only event. No business ID, reservation, provider reference, payload, signature, credential or customer identity is stored in the sink or correlation token.

## Nonclaims and controls

Visible records are not durable proof. Synthetic correlation is not a persistent identity or deduplication key. A duplicate observation does not authorize a financial action. The result remains `financialAuthorization: NOT_GRANTED`, `durableProof: false`, `exactlyOnce: false`. D4/R10 and signed-custody authorization gates remain untouched.

## Merge gates

Exact-head CI and independent security/architecture review must pass. DEV-26 must be merged and DEV-27's target base reconciled before DEV-27 can be considered mergeable. No automatic merging, deployment or DEV-28 advancement.
