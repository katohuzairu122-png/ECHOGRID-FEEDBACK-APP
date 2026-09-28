# Block 2C — Application Stabilization

Block 2C provides one repeatable entry point for repository preflight and
application verification. Every command writes machine-readable JSON under
`.artifacts/block13/`; that directory is intentionally ignored because the
evidence describes a particular checkout and execution environment.

## Commands

| Command | Gates |
| --- | --- |
| `pnpm block13:preflight` | Node and pnpm versions, Git checkout, required workspace files, frozen lockfile |
| `pnpm block13:verify:quick` | Preflight, migration drift, lint, API and web typechecks |
| `pnpm block13:verify` | Quick verification, all unit tests, API and web production builds |
| `pnpm block13:test:changed` | Preflight and unit suites selected from files changed since `HEAD~1` |

Set `BLOCK13_BASE` to a branch, tag, or commit when changed-file selection
must use another merge base. Set `BLOCK13_EVIDENCE_PATH` to redirect the JSON
artifact. An explicit invalid base fails instead of silently selecting the
wrong tests. Shared-type or workspace dependency changes select both suites;
documentation-only changes select neither.

Database-backed integration tests and browser end-to-end tests belong to the
next verification block. CI still runs API integration tests against its
ephemeral PostgreSQL service as an additional merge and deployment gate.

## Completion ledger

| Check | Evidence |
| --- | --- |
| Repository and toolchain preflight | Implemented by `tools/block13.mjs`; fails on unsupported Node/pnpm, missing workspace files, Git failure, or lockfile drift |
| Quick verification | Uses the same migration, lint, and typecheck commands as CI |
| Full verification | Adds both unit-test suites and both production builds |
| Changed-file testing | Deterministic selection with explicit shared-package fan-out |
| Machine-readable output | Versioned JSON with result, timestamps, environment, commands, durations, and individual step status |
| CI deployment evidence | Block completion requires a successful `main` workflow after these controls are published |
