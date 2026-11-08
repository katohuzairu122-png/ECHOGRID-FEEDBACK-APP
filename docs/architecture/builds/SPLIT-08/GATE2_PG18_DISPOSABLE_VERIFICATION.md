# Gate 2 — PostgreSQL 18 disposable clean-replay verification

**Status: DEVELOPMENT ONLY.** The new workflow `gate2-pg18-ephemeral.yml` runs for pull requests against **a PostgreSQL 18 Docker service container in GitHub Actions**, which GitHub disposes of at job completion. It has no Neon/Cloudflare/Stripe credentials, Hyperdrive access, staging deployment steps, or production resources. `workflow_dispatch` is available for separately approved repeat checks; the PR run is sufficient for code verification.

## Exact scope
- Hard-pin local database `echogrid_pg18_ci`, role `echogrid`, PostgreSQL major version 18.
- Replay the entire committed 67-entry migration journal on a fresh empty PG18 instance, run SQL schema/append-only evidence verification and API integration tests.
- Verify all 67 applied journal identities, the five existing Partner Credit write denial guards plus the new custody-link inert guard, six selected FORCE RLS tables, and eight non-login/non-bypass financial/evidence roles.
- The query verifier is read-only. Drizzle migrations are the only schema writes and occur **solely within the ephemeral PostgreSQL 18 CI container**.

## Limitations — NOT certification of existing staging
- This is **clean migration replay**, not a copy or upgrade of the existing staging database with its 45 applied migrations and potentially sensitive data.
- A PostgreSQL 18 Docker image is not proof of the exact Neon PostgreSQL 18.6 configuration, extensions, grants, hyperdrive pooling, or deployment secrets.
- No backup/restore drill, role-based adversarial tenant requests, staging API E2E, rollback of an existing database, or authorized 45→67 staging upgrade is performed.
- Do not enable provider reads, settlement authority, Partner Credits, payments, financial operations or public onboarding.
- **Gate 2 remains BLOCKED** after a green PG18 clean replay until an independently approved, controlled 45→67 staging clone test, backup restoration, runtime role/RLS and tenant isolation tests, and owner-controlled staging deployment verification pass.

## Evidence
PR workflow run records the immutable exact-head commit and per-step pass/failure in GitHub Actions. A failed migration/security check is an immediate NO-GO, not an invitation to rerun against staging. Tests must preserve all financial-denial triggers and never issue financial awards except within their existing dedicated, isolated concurrency test database (not included in this workflow).
