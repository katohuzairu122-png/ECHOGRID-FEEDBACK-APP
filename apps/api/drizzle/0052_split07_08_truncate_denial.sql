-- Block E hardening (additive, tightening only): the Split 07 / Split 08 financial tables created by 0040-0047 deny INSERT/UPDATE/DELETE with row-level
-- triggers, but a row-level trigger never fires on TRUNCATE, so a table owner could still wipe them. This adds statement-level BEFORE TRUNCATE denial to those
-- nine tables. No existing trigger, constraint, column or data is touched (0040-0047 stay byte-identical). Disposable databases that must truncate disable
-- the trigger explicitly, exactly as they already do for the write guards.
CREATE OR REPLACE FUNCTION financial_truncate_denied()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'TRUNCATE is denied on financial table % (inert until economic activation is separately authorized)', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER partner_credit_accounts_no_truncate BEFORE TRUNCATE ON partner_credit_accounts FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER partner_credit_award_decisions_no_truncate BEFORE TRUNCATE ON partner_credit_award_decisions FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER partner_credit_lots_no_truncate BEFORE TRUNCATE ON partner_credit_lots FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER partner_credit_ledger_no_truncate BEFORE TRUNCATE ON partner_credit_ledger FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER partner_credit_reservations_no_truncate BEFORE TRUNCATE ON partner_credit_reservations FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER partner_credit_recovery_obligations_no_truncate BEFORE TRUNCATE ON partner_credit_recovery_obligations FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER partner_credit_multiunit_lot_allocations_no_truncate BEFORE TRUNCATE ON partner_credit_multiunit_lot_allocations FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER partner_credit_multiunit_movements_no_truncate BEFORE TRUNCATE ON partner_credit_multiunit_movements FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER billing_partner_credit_applications_no_truncate BEFORE TRUNCATE ON billing_partner_credit_applications FOR EACH STATEMENT EXECUTE FUNCTION financial_truncate_denied();
