-- Split 07 Block 1 hardening. Additive SQL-only guardrails: no economic activation.
-- Published / retired policy economics are immutable, including once a draft is activated.
CREATE OR REPLACE FUNCTION partner_credit_policy_economics_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state <> 'draft' AND (
   NEW.version IS DISTINCT FROM OLD.version OR
   NEW.award_units IS DISTINCT FROM OLD.award_units OR
   NEW.monthly_cap IS DISTINCT FROM OLD.monthly_cap OR
   NEW.vest_days IS DISTINCT FROM OLD.vest_days OR
   NEW.expires_after_months IS DISTINCT FROM OLD.expires_after_months OR
   NEW.effective_at IS DISTINCT FROM OLD.effective_at
 ) THEN
   RAISE EXCEPTION 'Published Partner Credit policy economics cannot be modified';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER partner_credit_policy_economics_lock
BEFORE UPDATE ON partner_credit_policies
FOR EACH ROW EXECUTE FUNCTION partner_credit_policy_economics_immutable();
--> statement-breakpoint
-- Account and lot projections are inert in Block 1. A future implementation must
-- explicitly replace these barriers with audited, atomic transition functions.
CREATE OR REPLACE FUNCTION partner_credit_projection_inert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
   IF TG_TABLE_NAME = 'partner_credit_accounts' AND (
     NEW.available <> 0 OR NEW.provisional <> 0 OR NEW.reserved <> 0 OR NEW.recovery_due <> 0
   ) THEN
     RAISE EXCEPTION 'Partner Credit accounts must initialize at zero';
   END IF;
   IF TG_TABLE_NAME = 'partner_credit_lots' THEN
     RAISE EXCEPTION 'Partner Credit lots cannot be issued during Block 1';
   END IF;
   RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Partner Credit projection mutations disabled during Block 1';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER partner_credit_accounts_inert_guard
BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_accounts
FOR EACH ROW EXECUTE FUNCTION partner_credit_projection_inert_guard();
--> statement-breakpoint
CREATE TRIGGER partner_credit_lots_inert_guard
BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_lots
FOR EACH ROW EXECUTE FUNCTION partner_credit_projection_inert_guard();
--> statement-breakpoint
-- No ledger entries or award decisions can be inserted until Block 2 passes
-- its own activation gate. The existing ledger append-only guard still applies.
CREATE OR REPLACE FUNCTION partner_credit_economic_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Partner Credit economic issuance disabled during Block 1';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER partner_credit_ledger_insert_disabled
BEFORE INSERT ON partner_credit_ledger
FOR EACH ROW EXECUTE FUNCTION partner_credit_economic_activation_guard();
--> statement-breakpoint
CREATE TRIGGER partner_credit_awards_insert_disabled
BEFORE INSERT ON partner_credit_award_decisions
FOR EACH ROW EXECUTE FUNCTION partner_credit_economic_activation_guard();
--> statement-breakpoint
CREATE TRIGGER partner_credit_recovery_insert_disabled
BEFORE INSERT ON partner_credit_recovery_obligations
FOR EACH ROW EXECUTE FUNCTION partner_credit_economic_activation_guard();
