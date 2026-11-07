# DEV-36 — Deterministic Offline Integration Test Plan

Development-only. No database connection, Cloudflare/Stripe call, migration, deployment, or live test execution.

Run `node --test tools/dev36-sandbox-test-plan.test.mjs`.

`planDev36Sandbox(DEV36_PHASES, statuses)` builds a stable dependency order and returns explicit blockers. It accepts only statuses `NOT_RUN`, `PASS`, `FAIL`, `BLOCKED`. Passing statuses are **caller-supplied assertions**, not independently verified evidence; operator review of DEV-35 evidence remains mandatory. `eligibleForFutureManualTest` is scheduling guidance only, never runtime authorization.

The first sequence is baseline → isolation → configuration → migration approval → staging schema → API/web health → tenant isolation → QR feedback → loyalty award → redemption. Stripe test-mode credentials and sandbox billing follow a separate path after tenant isolation. Financial authorization is never granted by this plan.

Integration and migration are deferred until Tuesday, 2026-11-10 and require fresh explicit authorization, isolation checks and reviewed exact-main SHA. No automatic progression or production action.
