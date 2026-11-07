# DEV-56 — Manual Staging and Database Migration Workflow Contract

**Authorization:** Development-only, read-only static verification. No staging, production, database, Stripe or Cloudflare connection.

## Verified source focus
`.github/workflows/deploy-staging.yml`, `migrate-staging.yml`, `migrate-production.yml` and CI. Existing production release security is already covered by `deployment-governance.test.ts`; this block targets the separate staging and migration paths, where that suite has narrower coverage.

## Invariants tested
- Manual dispatch only for each workflow; no push/PR/schedule/repository-dispatch bypass.
- Exact reviewed 40-hex main SHA, typed operator confirmation and fail-fast shell.
- Read-only repository permissions, serialization and no cancellation of in-progress staging/migration operations.
- Staging and production migrations use their respective protected environments, distinct database-secret names, migration checks before apply and hash verification afterward.
- Staging API and web deployment targets are staging-only; CI never invokes any of these manual workflows.

## External controls that these tests cannot verify
- Whether GitHub staging/production environment required reviewers, branch restrictions and prevent-self-review are actually configured.
- Whether environment secrets are distinct from repository secrets and restricted to appropriate accounts.
- Whether a workflow dispatched from a non-main ref is refused by GitHub environment policy. Static checkout of `main` does not by itself prove an immutable execution boundary.
- The actual deployed Cloudflare configuration, database migrations or runtime behavior.

**Verdict:** Narrow static contract coverage only; not a staging or production certification. No workflows were dispatched or modified.
