-- ROLLBACK EVIDENCE for migration 0102 (governance_fraud_signals_dedup). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction,
-- after a restore point exists. 0102 only widens the case-classification CHECK and adds one partial unique index; no row is changed. Rolling back restores the 0101
-- classification list: it FAILS (safely) if any case already uses one of the new classifications, which must then be reviewed rather than altered.
-- Afterwards delete the newest drizzle ledger row (0102) so a later upgrade re-applies it.
BEGIN;
DROP INDEX IF EXISTS governance_cases_one_open_uq;
ALTER TABLE governance_cases DROP CONSTRAINT IF EXISTS governance_cases_classification;
ALTER TABLE governance_cases ADD CONSTRAINT governance_cases_classification CHECK (classification IN ('suspected_duplicate_participation','suspected_fabricated_evidence','allocation_dispute','collection_dispute','other'));
-- DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);  -- run after verifying the above
COMMIT;
