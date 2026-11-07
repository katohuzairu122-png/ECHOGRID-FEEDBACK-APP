# DEV-35 — Offline Sandbox Evidence Manifest

**Development-only.** No external calls, secrets, migration execution, financial authorization or deployment.

DEV-35 builds on DEV-33 readiness gates and DEV-34 offline preflight. It introduces a strict, fail-closed evaluator for a **future** isolated-staging test report. It does not assert that those tests have run.

Run tests: `node --test tools/dev35-sandbox-evidence.test.mjs`.

For a future approved test, a JSON manifest may be passed to `node tools/dev35-sandbox-evidence.mjs <manifest.json>`. Fields: `baselineSha` (40-character hex), `environment` (`isolated-staging`), `isolationVerified` (true), `migrationAuthorization` (`NOT_REQUESTED` or `EXPLICITLY_APPROVED`), `databaseMigrationStatus`, `apiHealth`, `webHealth`, `tenantIsolation`, `qrFeedback`, `loyaltyAward`, `loyaltyRedemption`, `billingSandbox` (each `NOT_RUN`, `PASS`, `FAIL`, `BLOCKED`, `NOT_APPLICABLE`), and nonsecret `evidenceReferences` (array of identifiers). Never put secrets or customer data in a manifest.

A complete manifest only reports `SANDBOX_EVIDENCE_COMPLETE`. It **never** authorizes production, settlement, payment, or deployment. The classifier trusts user-supplied evidence identifiers and does not independently verify external systems; an independent operator must validate evidence before acceptance.

DEV-35 is stacked on DEV-34 PR #258 until that block merges. Integration and migrations remain held for separately authorized Tuesday, 2026-11-10.
