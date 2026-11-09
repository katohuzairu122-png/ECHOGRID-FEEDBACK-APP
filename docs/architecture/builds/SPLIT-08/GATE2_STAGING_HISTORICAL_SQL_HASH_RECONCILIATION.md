# Gate 2 — Staging Read-Only Preflight Historical Hash Reconciliation

**Date:** 2026-11-09. **Mode:** read-only diagnosis, development-only preflight fix. **No staging migrations, journal edits, credential changes, deployments, role changes, runtime cutover or merging.**

## Observed GitHub Actions failure

Owner-dispatched manual workflow `Gate 2 staging connection target read-only preflight` reached the exact-history step and exited `JOURNAL_HASH_DENIED`. Since the code validates the configured endpoint host, database path, PostgreSQL 18, journal count and sequential timestamps before comparing source hashes, the failure **does not imply a wrong Neon endpoint**. The manual job did not run migration SQL.

## Independently verified root cause

- Live Neon staging original/default branch `br-bold-water-aukjlvw3`, project `lucky-glitter-47218268`, database `neondb` has exactly **45** stored migrations.
- Read-only source-file SHA-256 comparisons against live stored SQL hashes for migrations `0000` through `0004` returned **mismatch**. Migration `0044_split07_multiunit_inert_conservation` matched **exactly**.
- Repository authoritative `apps/api/scripts/verify-production-migrations.mjs` explicitly documents that **older Echo Grid migration files were normalized after deployment**, so their stored hashes legitimately differ while timestamp identity remains stable. The production verifier counts and reports historical matches rather than rejecting every mismatch.
- A stronger independent baseline is available: a canonical SHA-256 digest of all 45 stored migration `hash:created_at` pairs, separated by newline and ordered by `id`, equals **`6182f1afca2008d5467db9eb931cedf6b517319a0990fe493e7a5533dc532a0d`** on *both* the original staging branch and the separately restored pre-migration snapshot's first 45 rows. This was verified by read-only Neon queries. The timestamp-only digest also matched in both databases.
- Historical stored hashes are preserved as actual immutable applied evidence; do **not** overwrite `drizzle.__drizzle_migrations` or rewrite historic SQL.

## Correction proposed

The same manually triggered, read-only preflight now:

1. Requires the same exact source Neon hostname allowlist, restricted URL parameters, database name `neondb`, PostgreSQL 18, 45 rows, expected migration journal timestamps and five enabled financial guards.
2. Rejects **any change to the complete stored-hash+timestamp sequence** relative to the independently verified backup and original branch digest. This detects previously accepted historical SQL inconsistencies becoming new unexpected database history.
3. Computes all 45 source hashes and reports `exactRepositorySqlHashMatches` and `historicalSqlHashDifferences`, without confusing normalized historical SQL with migration journal corruption. Requires the most recent applied migration `0044` to still match exact SQL bytes.
4. Never publishes the connection string, password, host/user identity, raw SQL, session values, migration hashes or customer records. The reported booleans do **not** certify actual Cloudflare runtime identity or a Neon branch ID.
5. Performs **no migration or DDL/DML**; executes under `BEGIN READ ONLY` and rolls back.

## Mandatory constraints

- Keep the staging GitHub environment restricted to **main only** and enforce the owner-approved protection policy. Historical screenshot showed no reviewer and administrator-bypass enabled; independently verify any protection changes.
- This fix requires a separate reviewed PR and merge before manually rerunning the read-only workflow from **current main** using that exact full commit SHA and `VERIFY_STAGING_TARGET`. A passing workflow is **not** permission to run `migrate-staging.yml`.
- Existing runtime tenant safety is unresolved (`neondb_owner` has `BYPASSRLS`; regular business tables have no certified RLS). The actual staging migration and runtime cutover remain separately gated.

**Verdict:** root cause established as historical normalization mismatch. Preflight logic correction proposed; **fresh hosted CI and manually dispatched staging verification still required**.
