# Gate 2 R4 — PostgreSQL 18 Synthetic Fixtures, Backup and Restore

**Status:** Development-only evidence; not an existing-staging backup or restore certification.

## Purpose
Follow the verified R2 (clean PostgreSQL 18 migration replay) and R3 (45→67 synthetic empty-database upgrade) with a stricter disposable test that retains representative tenant records. No Neon clone, live customer data, Cloudflare secret, Stripe provider access, staging migration, or production resource is involved.

## Test boundary
The pull-request workflow spins up a temporary PostgreSQL 18 service container and pins two database names: `echogrid_ci_pg18_upgrade` and `echogrid_ci_pg18_restored`, accessible only over localhost. Both are destroyed when CI exits.

1. Apply exactly journal migrations 0000–0044 using a truncated journal **only inside the ephemeral Actions checkout**.
2. Seed two different synthetic businesses, branches, globally distinct customer identities and business-isolated loyalty accounts with fixed UUIDs. No real phone numbers, feedback, reward issuance, provider events or transaction payouts.
3. Create a compressed `pg_dump` at the 45-migration boundary and restore it into a second **disposable** database on the same service container. Use the PostgreSQL 18 container's native client tools.
4. Restore the full 67-entry journal from immutable Git, apply migrations 0045–0066 to the original database, and verify guards, RLS and all synthetic records.
5. Apply the same 22 migrations to the restored database and confirm the same record identity, tenant association and zero-point state survive.
6. Verify both migration inventories contain 67 entries with matching timestamps.

Failure must stop CI; the test never switches to an external target, turns off financial denial triggers, creates user-facing financial effects or represents an approved staging migration.

## Limitations
- This fixture test does not reproduce the shape or volume of actual staging data, locked tables, active connections, tenant isolation with application credentials, Neon branch-level recovery, backup retention, or time-to-recover.
- `pg_dump`/restore inside one ephemeral CI instance proves narrow logical dump reproducibility, not a durable off-site backup strategy. It does **not** establish staging rollback readiness.
- Gate 2 remains **BLOCKED** until separately owner-approved staging clone/upgrade, backup and restore drill, effective non-BYPASSRLS role and tenant-security tests, and environment protection checks.

**No merge or deployment is authorized by this document.**
