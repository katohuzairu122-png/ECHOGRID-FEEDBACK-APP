-- ROLLBACK EVIDENCE for migration 0109 (prof_global_profiles). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction, after a restore point.
-- 0109 is purely additive: three nullable customers columns (display_name, bio, avatar_key) with check constraints, and the new business_appearance table. Nothing existing is altered or backfilled.
-- Dropping them DELETES whatever customers and businesses have saved since, so this rollback REFUSES to run once any profile or appearance data exists (restore from the snapshot instead if that is truly intended).
-- Afterwards delete the newest drizzle ledger row (0109). The application code is safe either way: before 0109 the profile routes are simply not usable, and nothing else reads these columns.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE display_name IS NOT NULL OR bio IS NOT NULL OR avatar_key IS NOT NULL)
     OR EXISTS (SELECT 1 FROM business_appearance) THEN
    RAISE EXCEPTION '0109 rollback refused: profile or appearance data exists and would be deleted';
  END IF;
END
$$;
DROP TABLE business_appearance;
ALTER TABLE customers DROP CONSTRAINT customers_avatar_key_check;
ALTER TABLE customers DROP CONSTRAINT customers_bio_check;
ALTER TABLE customers DROP CONSTRAINT customers_display_name_check;
ALTER TABLE customers DROP COLUMN avatar_key;
ALTER TABLE customers DROP COLUMN bio;
ALTER TABLE customers DROP COLUMN display_name;
COMMIT;
