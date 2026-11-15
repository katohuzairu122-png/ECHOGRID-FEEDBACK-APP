# Migration governance (MIGRATION-GOV-01 C4)

## The rule

Adding a migration touches **only** `apps/api/drizzle/` (the SQL file, its `meta/NNNN_snapshot.json` and `meta/_journal.json`).
No Gate 2 script, workflow or release test may spell out the migration count, the last journal index or the last tag.

## How the gates learn the numbers

`apps/api/scripts/lib/migration-journal.mjs` reads the **committed** journal (`git show HEAD:apps/api/drizzle/meta/_journal.json`,
falling back to the file outside a git checkout) and exports `MIGRATION_COUNT`, `LAST_MIGRATION_INDEX`, `LAST_MIGRATION_TAG` and
the fixed staging-prefix anchors (`PREFIX_COUNT` = 45, `PREFIX_LAST_TAG`, `PREFIX_FIRST_PENDING_TAG`). Reading the committed copy
matters because the prefix-upgrade gate truncates the working-tree journal to 45 entries mid-run.

Workflows call the CLI: `node apps/api/scripts/lib/migration-journal.mjs count | last-index | last-tag | pending-range`.
Release code that is pure (for example `assessGate2PostMigration(evidence, expectedMigrations)`) takes the expected count from its caller.

## The guard

`apps/api/src/release/migration-governance.test.ts` fails when:

- a Gate 2 script that queries `__drizzle_migrations` does not use the shared module;
- a Gate 2 script, `gate2-*` workflow or release file contains the current count, the last index or the last tag as a literal;
- the journal and SQL files are inconsistent, or an entry from 0033 on has no Drizzle snapshot.

The guard's own matcher (`migration-governance.ts`) is unit tested for what it flags and what it ignores (ports, versions, PG majors).

## Proof

A simulated migration 0073 (journal entry, SQL file, snapshot, nothing else) leaves every release test and the guard green and the
CLI reports `74 / 0073_...`. See the PR description for the run.

## What this does NOT do

It does not apply migrations, change `migrate-staging.yml` or `migrate-production.yml`, or certify that staging or production
has applied anything. Applying a migration to any real database remains a separate, explicitly authorized step, and the
staging migration state must be verified before any staging deployment of code that depends on a new migration.
