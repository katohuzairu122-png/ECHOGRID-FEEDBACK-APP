# DEV-58 — Offline Exact-Head CI Metadata Classification

**Authorization:** Development-only, pure deterministic report function and regressions.

## Rationale
DEV-34–39 already classify **offline Stripe/sandbox readiness inputs**. DEV-58 does not replace or repeat that domain. It targets a separate ambiguity: a release or PR status narrative might promote caller-supplied GitHub CI metadata into claims of independent verification, staging completion or deployment permission.

## Contract
`assessDev58ReleaseEvidence` accepts a 40-hex baseline SHA and optional CI run metadata (commit SHA, positive run ID, run status and conclusion). It:
- Fails closed for missing, malformed, stale-head, incomplete, cancelled, skipped or failed CI metadata.
- Labels matching successful records only `OFFLINE_CI_RECORD_CONSISTENT`, **not** merge-ready, production-ready or approved.
- Never echoes arbitrary CI log data, secrets, URLs, actor strings or unknown input fields.
- Always reports independent verification, staging runtime verification, production runtime verification, merge, migration and deployment authorization as **false**. Financial authorization is always `NOT_GRANTED`.
- Keeps external reviewer, environment, staging validation and release authorization gates explicit.
- Never uses the network, database, filesystem or a dispatch API.

Tests in `apps/api/src/release/offline-release-evidence.test.ts` exercise spoofed approval fields, stale/failed CI and confidentiality.

## Required next evidence
Before any release decision, independently reconcile current main and all outstanding PRs (including the not-yet-merged Group 3), inspect real exact-head CI, verify owner-controlled GitHub environment protections and secrets, and obtain separately authorized staging verification. Production execution, financial operations and merging remain outside this block.

**Verdict:** Offline evidence contract only. No deployment or independent live certification.
