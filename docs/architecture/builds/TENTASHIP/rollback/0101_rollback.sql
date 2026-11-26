-- ROLLBACK EVIDENCE for migration 0101 (governance_cases_overrides). NOT EXECUTED against any shared database. Run only on Owner instruction, in a
-- transaction, after a restore point exists. Additive (new tables and functions only). DESTROYS synthetic governance cases, evidence, case chains, overrides and
-- operator assignments: back up first. Afterwards delete the newest drizzle ledger row (0101) so a later upgrade re-applies it.
BEGIN;
DROP TABLE IF EXISTS governance_overrides;
DROP TABLE IF EXISTS governance_events;
DROP TABLE IF EXISTS governance_case_evidence;
DROP TABLE IF EXISTS governance_cases;
DROP TABLE IF EXISTS governance_operators;
DROP FUNCTION IF EXISTS governance_overrides_guard();
DROP FUNCTION IF EXISTS governance_events_chain();
DROP FUNCTION IF EXISTS governance_evidence_guard();
DROP FUNCTION IF EXISTS governance_cases_guard();
DROP FUNCTION IF EXISTS governance_operators_guard();
DROP FUNCTION IF EXISTS governance_append_only();
-- DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);  -- run after verifying the above
COMMIT;
