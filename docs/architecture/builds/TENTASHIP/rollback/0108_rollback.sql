-- ROLLBACK EVIDENCE for migration 0108 (kwd_three_decimal_storage). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction, after a restore point exists.
-- 0108 widens four loyalty money columns from numeric(10,2) to numeric(11,3) (same eight whole digits, one more decimal). Every existing value is preserved exactly (12.50 becomes 12.500).
-- Narrowing back to two decimals would ROUND any value that has a non-zero third decimal, so this rollback REFUSES to run once such a value exists (that is real three-decimal data, for example Kuwaiti dinar).
-- Afterwards delete the newest drizzle ledger row (0108). The application code is safe at either width: it reads the column scale from the catalogue and refuses a third decimal while the columns are narrow.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM loyalty_purchase_events WHERE qualifying_amount <> round(qualifying_amount, 2))
     OR EXISTS (SELECT 1 FROM loyalty_rewards WHERE reward_value <> round(reward_value, 2) OR max_budget <> round(max_budget, 2))
     OR EXISTS (SELECT 1 FROM loyalty_transactions WHERE purchase_amount <> round(purchase_amount, 2)) THEN
    RAISE EXCEPTION '0108 rollback refused: three-decimal amounts exist and would be rounded';
  END IF;
END
$$;
ALTER TABLE loyalty_rewards ALTER COLUMN reward_value SET DATA TYPE numeric(10, 2);
ALTER TABLE loyalty_rewards ALTER COLUMN max_budget SET DATA TYPE numeric(10, 2);
ALTER TABLE loyalty_purchase_events ALTER COLUMN qualifying_amount SET DATA TYPE numeric(10, 2);
ALTER TABLE loyalty_transactions ALTER COLUMN purchase_amount SET DATA TYPE numeric(10, 2);
COMMIT;
