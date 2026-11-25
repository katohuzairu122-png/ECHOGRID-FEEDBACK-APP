# Migration reconciliation 0087 → 0090 (CF-READINESS-2)

Observed 2026-11-25 by read-only SQL on both Neon projects (both run PostgreSQL 18) and local disposable PostgreSQL 16. **No shared database was modified.**

## 1. What "ledger 88" means
It is the **count of applied rows** in `drizzle.__drizzle_migrations` (ids 1–88, 88 distinct hashes), not a migration number. Rows map to migrations **0000–0087**. For both staging and production, each row's `created_at` equals the journal `when` of the entry at the same position (all 88 in order; no gap, no extra). The next pending entries are 0088, 0089 and now 0090 (the journal has 91 entries, idx 0–90).

## 2. Why the runner decides by timestamp, not hash
The Drizzle PostgreSQL migrator compares the latest applied `created_at` with each journal `when`; `verify-production-migrations.mjs` documents that older migrations were normalized after being applied, so stored hashes can legitimately differ. Checksum comparison against the repository files (SHA-256 of each file):
| Target | Rows | Mismatching idx (stored hash ≠ current file) |
|---|---|---|
| Production | 88 | 0, 6, 11, 12, 18, 19, 20, 21 (8) |
| Staging | 88 | the same 8, plus 1, 2, 3, 4, 5 (13) |
Rows 1–5 in staging differ from production's stored hashes; those five files were all last changed in one commit on 2026-11-12 (`8c9d0dc`), consistent with a normalization after staging had applied them (inference, not proven). None of these differences blocks the pending range; **the exact-prefix attestation the release operator performs must list them as known legacy exceptions** and must show 0087's hash `fab77c0d…` matching on both targets (it does).

## 3. Pending range and risk
| idx | migration | sha256 (first 16) | content | lock/validation risk |
|---|---|---|---|---|
| 88 | 0088_community_membership_consent | `2a9dd536afacd36b` | two empty terms tables, two CHECK swaps, guards, one partial unique index | negligible (0 memberships; ≤ 3 consent rows) |
| 89 | 0089_customer_deletion_requests | `3ce8df8edd63f6a3` | one new table + guard | none (new table) |
| 90 | 0090_community_pilot_eligibility | `e124c9cdf90eab46` | one new table + append-only guard | none (new table) |
The runner applies all three together. Approving "0088" alone is not possible.

## 4. Disposable-database evidence (PostgreSQL 16, real `drizzle-kit migrate`)
- **Clean install** 0000–0090: ledger 91.
- **Upgrade from the actual preceding schema:** built the exact 0000–0087 prefix (88 rows, last `created_at` 1795250000000 = production/staging), loaded synthetic data (25 customers, 10 memberships, 10 point accounts, 25 consents, 25 audit rows), ran the real runner: ledger 91; **MD5 fingerprints of all five data tables identical before and after**; the four new tables exist (terms pointer row present with no current publication, others empty); the status CHECK now allows `inactive`; all five guards enabled; `audit_log` UPDATE still refused.
- **Failure recovery:** an intentionally broken 0090 on a fresh prefix database: the migrator failed and **the whole pending batch rolled back** (ledger stayed 88; no 0088/0089/0090 object exists). This verifies single-transaction application on PG16 (AR02 had it unverified).
- **Restore compatibility:** `pg_dump`/`pg_restore` of the upgraded database into a new database: ledger 91, data fingerprints identical, guards enabled, `audit_log` immutability enforced.
- **PostgreSQL 18:** hosted jobs replay the full journal on `postgres:18` at every PR head, and the new `community-pg18-acceptance.yml` runs the Community suites and the browser journeys on PostgreSQL 18.7 (results in the certificate). Both Neon projects run PostgreSQL 18, so the hosted PG18 result is the one that matches the targets.

## 5. Proposed staging execution procedure (NOT AUTHORIZED; needs the G2 approval block)
1. Record `main` tip SHA (40 hex). Confirm the journal tail is 0088, 0089, 0090 with the hashes above.
2. Create a fresh restore point of staging branch `br-bold-water-aukjlvw3` (Neon snapshot or restore-drill branch) and record its id.
3. Re-run the read-only ledger check (88 rows, last `created_at` 1795250000000, no 0088–0090 objects).
4. Dispatch the existing protected workflow `migrate-staging.yml` for that exact SHA with the typed confirmation `MIGRATE_STAGING` (the workflow, not a hand-run SQL, is the real Drizzle path).
5. Verify read-only: ledger = 91; the four new tables exist and are empty (terms pointer row present with `publication_id` null); `community_memberships` still 0; no flag set; `audit_log` fingerprint unchanged.
6. On any failure: do not patch by hand; the batch rolls back; restore only as a last resort.
**Production migration is prohibited under this workstream.**
