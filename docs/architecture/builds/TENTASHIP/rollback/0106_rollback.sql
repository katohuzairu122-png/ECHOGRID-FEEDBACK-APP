-- ROLLBACK EVIDENCE for migration 0106 (shuffle_notification_deliveries). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction, after a restore point exists.
-- The table holds synthetic delivery-decision history only; the intents themselves (shuffle_notification_intents) are untouched. Afterwards delete the newest drizzle ledger row (0106).
BEGIN;
ALTER TABLE shuffle_notification_deliveries DISABLE TRIGGER shuffle_notification_deliveries_no_truncate;
DROP TABLE IF EXISTS shuffle_notification_deliveries;
DROP FUNCTION IF EXISTS shuffle_notification_deliveries_guard();
-- DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);  -- run after verifying the above
COMMIT;
