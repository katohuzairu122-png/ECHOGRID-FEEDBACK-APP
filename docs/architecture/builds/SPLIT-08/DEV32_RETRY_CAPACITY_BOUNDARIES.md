# DEV-32 — Retry Capacity and History Boundaries

**Scope:** development-only, test-only, stacked on DEV-31 PR #255 pending owner merge.

## Checks

- Exactly 1000 synthetic attempts accepted; attempt 1001 rejected without mutating the existing correlation sequence.
- Capacity validation rejects zero, negative, fractional, nonfinite and greater-than-1000 values.
- Capacities 1, 2 and 1000 enforce the maximum, recycle slots after end, and never recycle opaque token identity.
- Invalid visible-record counts cannot poison an existing sequence.
- At visible record count 1000, classification remains frozen, non-durable and without financial authority.

No runtime integration, provider calls, database migration, durable custody, settlement or deployment. After DEV-31 merges, retarget PR to main and verify exact-head CI and mergeability. Independent security/architecture review required before owner merge. No auto-merge or DEV-33.
