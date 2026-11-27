-- ROLLBACK EVIDENCE for migration 0107 (loyalty_programs_foundation). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction, after a restore point exists.
-- It REFUSES to run if any programme-generated history exists (a ledger row carrying a programme, a non-legacy programme, progress or entitlements): dropping those would destroy evidence.
-- Only the untouched legacy backfill (one LP-03 programme per existing business, version 1) may be dropped. Balances, ledger rows, rewards and tiers are never modified by 0107 or by this rollback.
-- Afterwards delete the newest drizzle ledger row (0107).
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM loyalty_transactions WHERE program_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM loyalty_programs WHERE legacy = false)
     OR EXISTS (SELECT 1 FROM loyalty_programs WHERE legacy = true AND current_version > 1)
     OR EXISTS (SELECT 1 FROM loyalty_program_progress)
     OR EXISTS (SELECT 1 FROM loyalty_program_progress_events)
     OR EXISTS (SELECT 1 FROM loyalty_program_entitlements)
     OR EXISTS (SELECT 1 FROM loyalty_program_setup) THEN
    RAISE EXCEPTION '0107 rollback refused: programme-generated history exists and would be destroyed';
  END IF;
END
$$;
ALTER TABLE loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_program_provenance_check;
ALTER TABLE loyalty_transactions DROP COLUMN IF EXISTS program_version;
ALTER TABLE loyalty_transactions DROP COLUMN IF EXISTS program_id;
ALTER TABLE loyalty_programs DISABLE TRIGGER loyalty_programs_no_truncate;
ALTER TABLE loyalty_program_versions DISABLE TRIGGER loyalty_program_versions_no_truncate;
ALTER TABLE loyalty_program_events DISABLE TRIGGER loyalty_program_events_no_truncate;
ALTER TABLE loyalty_program_progress DISABLE TRIGGER loyalty_program_progress_no_truncate;
ALTER TABLE loyalty_program_progress_events DISABLE TRIGGER loyalty_program_progress_events_no_truncate;
ALTER TABLE loyalty_program_entitlements DISABLE TRIGGER loyalty_program_entitlements_no_truncate;
-- The guards forbid deleting history, so they are disabled for this one controlled removal of the (verified empty or legacy-only) tables.
ALTER TABLE loyalty_programs DISABLE TRIGGER loyalty_programs_guard_trg;
ALTER TABLE loyalty_program_versions DISABLE TRIGGER loyalty_program_versions_guard_trg;
ALTER TABLE loyalty_program_events DISABLE TRIGGER loyalty_program_events_guard_trg;
DROP TABLE IF EXISTS loyalty_program_entitlements;
DROP TABLE IF EXISTS loyalty_program_progress_events;
DROP TABLE IF EXISTS loyalty_program_progress;
DROP TABLE IF EXISTS loyalty_program_setup;
DROP TABLE IF EXISTS loyalty_program_events;
DROP TABLE IF EXISTS loyalty_program_versions;
DROP TABLE IF EXISTS loyalty_programs;
DROP FUNCTION IF EXISTS loyalty_program_entitlements_guard();
DROP FUNCTION IF EXISTS loyalty_program_progress_guard();
DROP FUNCTION IF EXISTS loyalty_program_append_only_guard();
DROP FUNCTION IF EXISTS loyalty_programs_guard();
-- DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);  -- run after verifying the above
COMMIT;
