# DEV-30 — Deterministic Correlation State-Machine Verification

**Scope:** development-only tests, no production changes.

## Baseline

DEV-29 PR #253 has merged. DEV-30 PR #254 now targets authoritative main; reconcile the exact diff and require exact-head CI.

## Verification

- Execute a fixed-seed 600-step state-machine sequence of begin, append, classify, and end actions across up to three independent opaque tokens.
- Compare each synthetic classification against the DEV-26 pure classifier oracle.
- Verify active capacity bounds, stale-token rejection, fresh token identity, and independence of interleaved sequences.
- Reject contradictory or malformed attempts without consuming capacity or changing prior classification.
- Assert every returned classification remains financialAuthorization NOT_GRANTED, durableProof false and exactlyOnce false.

This is a deterministic in-memory regression exercise, **not** a proof of durable custody, signed evidence, exactly-once execution, settlement, financial authority or provider behavior.

## Owner gates

Do not merge or deploy automatically. Require exact-head CI, mergeability check and independent architecture/security review before owner merge. Do not advance to DEV-31.
