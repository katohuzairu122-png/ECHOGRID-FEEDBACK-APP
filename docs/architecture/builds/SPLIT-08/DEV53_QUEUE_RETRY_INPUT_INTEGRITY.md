# DEV-53 — Queue Retry Attempt-Count Integrity

**Scope:** Pure input validation at the existing shared bounded-exponential backoff helper. Development only.

## Baseline finding
`computeRetryDelaySeconds` rejected attempts below 1 but did not reject `NaN`, infinities, fractions or unsafe integers. For instance `NaN` produced a non-finite retry delay, which is invalid as a queue retry option.

## Implementation
- Require positive safe integers before exponentiation.
- Preserve exactly the existing 30, 60, 120, 240, 300-second capped schedule for valid attempt counts.
- Add edge-value and schedule-invariance regressions in `backoff.test.ts`.

This does not change Cloudflare queue configuration, provider retries, per-job semantics, acknowledgment, dead-letter handling or financial actions. The Worker runtime is expected to supply valid attempt numbers; rejected invalid numbers are a defensive fail-closed invariant.

**Verification:** Exact-head API tests, typechecks and hosted CI must pass before owner review.
