-- ROLLBACK EVIDENCE for migrations 0094 (business_closure_requests) and 0095 (Tentaship Badges). NOT EXECUTED against any shared database.
-- Run only on Owner instruction, inside a transaction, after a restore point exists. Both migrations are additive: they create new tables and
-- functions only and touch no existing table, row, constraint or trigger, so this script removes exactly what they added and nothing else.
-- It DESTROYS any closure requests and any badge definitions, awards and revocations recorded since the upgrade (ledger data): take a backup first.
-- After it, delete the two drizzle ledger rows (the two highest `created_at` values) so a later upgrade re-applies them.
BEGIN;
DROP TABLE IF EXISTS tentaship_badge_revocations;
DROP TABLE IF EXISTS tentaship_badge_awards;
DROP TABLE IF EXISTS tentaship_badge_definition_versions;
DROP TABLE IF EXISTS tentaship_badge_definitions;
DROP FUNCTION IF EXISTS tentaship_badge_versions_guard();
DROP FUNCTION IF EXISTS tentaship_badge_append_only();
DROP TABLE IF EXISTS business_closure_requests;
DROP FUNCTION IF EXISTS business_closure_requests_guard();
COMMIT;
