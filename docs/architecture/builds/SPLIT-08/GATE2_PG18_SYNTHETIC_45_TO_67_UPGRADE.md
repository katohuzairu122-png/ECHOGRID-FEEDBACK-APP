# Gate 2 R3 — Synthetic PostgreSQL 18 45→67 Upgrade

**Status: DEVELOPMENT ONLY — no staging or production database access, write, migration, snapshot or deployment.**

This independent CI exercise tests the exact code migration sequence from the 45-migration historical baseline to all 67 migrations using a brand-new PostgreSQL 18 service container. The database `echogrid_ci_pg18_upgrade` exists only inside the GitHub Actions job; its host and database identity are pinned by an explicit guard. It is never the Neon staging branch called `production`.

1. Read and validate the committed 67-entry Drizzle journal at the exact PR commit.
2. In the disposable CI checkout only, temporarily replace journal metadata with its original first 45 entries; leave all SQL files unchanged.
3. Apply migrations `0000`–`0044`, verify the exact 45 migration identifiers and absence of future signed-evidence schema.
4. Restore the journal exactly from Git (and require a clean diff).
5. Apply the pending `0045`–`0066` migrations; verify all 67 journal identities, RLS-enabled/FORCE tables and financial inert guards.
6. Any failure blocks completion; no automatic fallback, database target switch, or bypass of the restricted financial controls.

**Scope limitations:** It does not copy or simulate the data distribution of actual staging; thus existing-data DDL constraints, lock impact, Neon-specific PostgreSQL 18.6 settings, application Hyperdrive credentials, RLS with a non-owner runtime user, backup/restore and customer journey E2E are all **NOT VERIFIED**. Nor does it certify a production migration or authorize deployment, customer onboarding, payments or Partner Credit economic activation. Actual staging remains at the last independently observed 45/67 migrations until separately rechecked.

**Required follow-up:** independent owner-approved staging clone (only with approved data handling), controlled upgrade, backup/restore test and non-BYPASSRLS adversarial tenant isolation validation. Stop and file a corrective development PR for any regression.
