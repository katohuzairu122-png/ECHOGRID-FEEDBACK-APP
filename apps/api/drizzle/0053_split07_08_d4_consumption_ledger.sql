-- D4 (Final credit consumption and ledger accounting): ADDITIVE, INERT, development only. The 0041/0042 write guards are NOT touched and stay enabled
-- outside an isolated disposable database; nothing here activates consumption. It gives the (still denied) consumption path a vocabulary and
-- database-enforced invariants, so that when activation is separately authorized the evidence verifier is already in the database, not only in TypeScript.
--
-- 1. Ledger vocabulary. `consume` (-1) leaves the buckets and is counted in the ledger identity (SUM of provisional/reverse/expire/recovery_offset/consume
--    = provisional + available + reserved). `consumed_reversal` (+1) records that a reversal reached an already-consumed credit and originated a recovery
--    obligation; it is informational and NOT counted (the obligation is a debt, not a balance). Existing entry types, rows and constraints are unchanged.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'partner_credit_ledger'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%entry_type%' AND pg_get_constraintdef(oid) LIKE '%provisional%'
  LOOP
    EXECUTE format('ALTER TABLE partner_credit_ledger DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "partner_credit_ledger" ADD CONSTRAINT "partner_credit_ledger_type_check" CHECK ("partner_credit_ledger"."entry_type" IN ('provisional','vest','expire','reverse','recovery_offset','admin_adjustment','consume','consumed_reversal'));--> statement-breakpoint
ALTER TABLE "partner_credit_ledger" ADD CONSTRAINT "partner_credit_ledger_d4_units_check" CHECK (("partner_credit_ledger"."entry_type" = 'consume' AND "partner_credit_ledger"."units" = -1) OR ("partner_credit_ledger"."entry_type" = 'consumed_reversal' AND "partner_credit_ledger"."units" = 1) OR "partner_credit_ledger"."entry_type" NOT IN ('consume','consumed_reversal'));--> statement-breakpoint
CREATE UNIQUE INDEX "partner_credit_ledger_one_consume_per_decision" ON "partner_credit_ledger" USING btree ("decision_id") WHERE "partner_credit_ledger"."entry_type" = 'consume';--> statement-breakpoint
CREATE UNIQUE INDEX "partner_credit_ledger_one_consumed_reversal_per_decision" ON "partner_credit_ledger" USING btree ("decision_id") WHERE "partner_credit_ledger"."entry_type" = 'consumed_reversal';--> statement-breakpoint
-- 2. Database-queryable consumption evidence verifier (CE-1: "no generated data structure is evidence by itself"). A reservation may become `consumed` only
--    when the trusted Split 08 terminal application row exists for exactly that reservation and business, applied, same units, AND the saga intent for it is
--    in the reconciled `consumed` state with the same provider effect. `consumed` is terminal; `released` is terminal.
CREATE OR REPLACE FUNCTION partner_credit_reservation_consume_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('consumed','released') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Partner Credit reservation in a terminal state cannot change';
  END IF;
  IF NEW.state = 'consumed' AND OLD.state <> 'consumed' THEN
    IF OLD.state <> 'reserved' THEN
      RAISE EXCEPTION 'Only a reserved reservation can be consumed';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM billing_partner_credit_applications a
        JOIN benefit_application_intents i ON i.reservation_id = a.reservation_id AND i.business_id = a.business_id
       WHERE a.reservation_id = NEW.id AND a.business_id = NEW.business_id
         AND a.terminal_state = 'applied' AND a.units_applied = NEW.units
         AND i.state = 'consumed' AND i.outcome = 'confirmed' AND i.provider_effect_ref = a.provider_success_ref AND i.invoice_ref = a.invoice_ref
    ) THEN
      RAISE EXCEPTION 'Consumption requires the verified Split 08 terminal application and a reconciled saga for this reservation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER partner_credit_reservations_consume_evidence
 BEFORE UPDATE ON partner_credit_reservations
 FOR EACH ROW EXECUTE FUNCTION partner_credit_reservation_consume_evidence();--> statement-breakpoint
-- 3. A lot may become `consumed` only from `reserved`, only once its reservation is consumed, and may leave `consumed` only to `reversed` (consumed-credit
--    reversal preserves the consumption history in the reservation, application and ledger).
CREATE OR REPLACE FUNCTION partner_credit_lot_consume_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'consumed' AND OLD.status <> 'consumed' THEN
    IF OLD.status <> 'reserved' THEN
      RAISE EXCEPTION 'Only a reserved lot can be consumed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.lot_id = NEW.id AND r.state = 'consumed') THEN
      RAISE EXCEPTION 'A lot is consumed only after its reservation is consumed';
    END IF;
  END IF;
  IF OLD.status = 'consumed' AND NEW.status NOT IN ('consumed','reversed') THEN
    RAISE EXCEPTION 'A consumed lot can only be reversed';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER partner_credit_lots_consume_transition
 BEFORE UPDATE ON partner_credit_lots
 FOR EACH ROW EXECUTE FUNCTION partner_credit_lot_consume_transition();--> statement-breakpoint
-- 4. D4 ledger rows are written only against a consumed reservation of exactly that decision and account.
CREATE OR REPLACE FUNCTION partner_credit_ledger_d4_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entry_type IN ('consume','consumed_reversal') THEN
    IF NEW.decision_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM partner_credit_reservations r
       WHERE r.decision_id = NEW.decision_id AND r.account_id = NEW.account_id AND r.state = 'consumed'
    ) THEN
      RAISE EXCEPTION 'A consumption ledger entry requires a consumed reservation of this decision and account';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER partner_credit_ledger_d4_evidence
 BEFORE INSERT ON partner_credit_ledger
 FOR EACH ROW EXECUTE FUNCTION partner_credit_ledger_d4_evidence();
