# DEV-57 — Release Runbook and Cron Schedule Reconciliation

**Authorization:** Development-only documentation repair and read-only regression assertions.

## Evidence-based corrections
- `docs/DEPLOYMENT.md` previously asserted that nothing had ever deployed, dependencies did not exist, migrations were never generated and Cloudflare resources were all placeholders. Those historical assertions are not justified by a Git checkout and are removed.
- Runtime environment and migration status are now explicitly **UNVERIFIED** until independently checked using the responsible operator's Cloudflare, Neon and GitHub evidence.
- Credential guidance no longer presumes repository-level Cloudflare secret existence; it instead directs owner review of GitHub environment approvals, secret names, scope and isolation.
- The production API `wrangler.toml` currently declares **four** cron schedules; staging declares **one**. The production checklist and deploy runbook were corrected rather than retaining the stale two-cron statement.
- `docs/LAUNCH-READINESS.md` now explicitly disallows conflating PR CI with a post-deployment Block 2H technical-go attestation.

## Static regression coverage
`apps/api/src/release/release-guidance-consistency.test.ts` checks the cron counts against the actual Wrangler text, the matching checklist claims and explicit no-live-claim language.

Documentation changes do not execute setup, migration, release, rollback, billing or settlement operations and do not certify any environment.
