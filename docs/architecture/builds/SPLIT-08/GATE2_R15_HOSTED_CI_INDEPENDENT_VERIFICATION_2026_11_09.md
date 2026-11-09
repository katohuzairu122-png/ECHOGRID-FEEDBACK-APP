# Gate 2 R15 — Mandatory CI Independent Hosted Execution

Date: 2026-11-09. **Verification-only; no production activation.**

The standalone `gate2-r15-actor-request-binding.yml` workflow has reported startup failures before allocating any jobs, leaving no test logs or annotations. Local R15 tests passed, but are not equivalent to hosted verification.

This change does **not** remove, rename, skip, or weaken the standalone R15 workflow. It adds the exact same offline Node test and its forbidden environment-variable reference guard to the mandatory `ci-cd.yml` verification job, which already runs in hosted GitHub Actions and is reused by the production release flow. Because the R15 tests are offline, adding them does not require production credentials, service tokens, Cloudflare permissions, Neon access, or new databases. The new step runs before the web unit tests, so an R15 regression fails the host CI and therefore blocks the existing release workflow.

The independent failure of the dedicated workflow remains an unresolved GitHub Actions configuration/platform diagnostic. Passing integrated CI does not falsely relabel that workflow as passing or certify a broker/runtime boundary.

Main baseline `6ea2f0c5179eb3acbaf24c3cdb481c37e2d0f89b`, where B4-09 PR #332 was already merged. No broker deployment, login provisioning, Hyperdrive modifications, migrations, settlement activation, or production release occur in this block.

**Acceptance:** Hosted exact-commit CI/CD completes successfully and logs `Gate 2 R15 actor-to-request offline security contract` with 14 passing tests. Standalone workflow findings remain recorded and must be investigated separately.
