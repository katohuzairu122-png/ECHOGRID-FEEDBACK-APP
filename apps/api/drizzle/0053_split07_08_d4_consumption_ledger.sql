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
-- 2. Application key. 0042 made it UNIQUE (business_id, invoice_ref), but the approved aggregate allocation (S08-AGG-ROUND/1) places up to 10 reservations on ONE
--    invoice, so a second reservation could never be recorded. The key becomes per reservation; the number of applications an invoice can have is bounded by its
--    frozen allocation items, which the verifier below requires for every application.
ALTER TABLE "billing_partner_credit_applications" DROP CONSTRAINT "billing_partner_credit_applications_invoice_once";--> statement-breakpoint
ALTER TABLE "billing_partner_credit_applications" ADD CONSTRAINT "billing_partner_credit_applications_invoice_reservation_key" UNIQUE ("business_id","invoice_ref","reservation_id");--> statement-breakpoint
-- 3. Database-queryable consumption evidence verifier (CE-1: "no generated data structure is evidence by itself"). A reservation is CREATED reserved and may become
--    `consumed` only when the verified application, a saga reconciled to `consumed` (same provider effect and invoice) AND the frozen allocation item for it (same
--    invoice, same invoice-intent reference, same currency and benefit amount) all exist. `consumed` and `released` are terminal. The application row itself is deliberately NOT verified at insert: the
--    0042/0047 persistence constraints are tested directly against bare rows and must keep behaving exactly as they do; consumption is where the evidence is judged.
CREATE OR REPLACE FUNCTION partner_credit_reservation_consume_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' THEN
      RAISE EXCEPTION 'A Partner Credit reservation is created reserved; it becomes consumed or released only by a verified transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('consumed','released') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Partner Credit reservation in a terminal state cannot change';
  END IF;
  IF OLD.state IN ('consumed','released') AND (
       NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.units IS DISTINCT FROM OLD.units OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at OR
       NEW.invoice_intent_ref IS DISTINCT FROM OLD.invoice_intent_ref OR NEW.lot_id IS DISTINCT FROM OLD.lot_id OR NEW.decision_id IS DISTINCT FROM OLD.decision_id OR
       NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.business_id IS DISTINCT FROM OLD.business_id) THEN
    RAISE EXCEPTION 'Partner Credit reservation in a terminal state is immutable';
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
         AND i.units = NEW.units AND a.applied_at = i.applied_at AND i.applied_at <= NEW.expires_at
    ) THEN
      RAISE EXCEPTION 'Consumption requires the verified Split 08 terminal application and a reconciled saga for this reservation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM s08_allocation_freeze_items it
        JOIN s08_allocation_freezes f ON f.id = it.freeze_id AND f.business_id = it.business_id
        JOIN benefit_application_intents i ON i.reservation_id = it.reservation_id AND i.business_id = it.business_id
        JOIN billing_partner_credit_applications a ON a.reservation_id = it.reservation_id AND a.business_id = it.business_id
       WHERE it.reservation_id = NEW.id AND it.business_id = NEW.business_id AND it.invoice_intent_ref = NEW.invoice_intent_ref
         AND f.invoice_ref = a.invoice_ref AND f.currency = i.currency AND it.benefit_minor = i.expected_benefit_minor
    ) THEN
      RAISE EXCEPTION 'Consumption requires the frozen allocation of this reservation to match the applied invoice, currency and amount';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER partner_credit_reservations_consume_evidence
 BEFORE INSERT OR UPDATE ON partner_credit_reservations
 FOR EACH ROW EXECUTE FUNCTION partner_credit_reservation_consume_evidence();--> statement-breakpoint
-- 4. Lot transitions. Invoice consumption is `reserved` -> `consumed` and requires its reservation to be consumed. The pre-existing vest path that lets a recovery
--    debt absorb the vesting unit (`provisional` -> `consumed`, written by the lifecycle service) is deliberately left exactly as it was. Nothing else may
--    become `consumed`, and a consumed lot may only be reversed (the reservation, application and ledger keep the history).
CREATE OR REPLACE FUNCTION partner_credit_lot_consume_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'consumed' AND OLD.status <> 'consumed' THEN
    IF OLD.status = 'reserved' THEN
      IF NOT EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.lot_id = NEW.id AND r.state = 'consumed') THEN
        RAISE EXCEPTION 'A reserved lot is consumed only after its reservation is consumed';
      END IF;
    ELSIF OLD.status <> 'provisional' THEN
      RAISE EXCEPTION 'A lot becomes consumed only from reserved (invoice consumption) or provisional (recovery-offset vest)';
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
-- 5. D4 ledger rows are written only against a consumed reservation of exactly that decision and account.
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
