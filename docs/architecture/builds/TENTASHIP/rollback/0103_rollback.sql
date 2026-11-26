-- ROLLBACK EVIDENCE for migration 0103 (shuffle_drop_allocations). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction,
-- after a restore point exists. The table holds synthetic provenance only (entry -> reservation link); drop_reservations and drop_inventory (the unit state) are untouched.
-- Afterwards delete the newest drizzle ledger row (0103) so a later upgrade re-applies it.
BEGIN;
ALTER TABLE shuffle_drop_allocations DISABLE TRIGGER shuffle_drop_allocations_no_truncate;
DROP TABLE IF EXISTS shuffle_drop_allocations;
DROP FUNCTION IF EXISTS shuffle_drop_allocations_guard();
-- DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);  -- run after verifying the above
COMMIT;
