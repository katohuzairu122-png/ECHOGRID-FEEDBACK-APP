ALTER TABLE "partner_credit_ledger" DROP CONSTRAINT "partner_credit_ledger_type_check";--> statement-breakpoint
CREATE UNIQUE INDEX "partner_credit_ledger_one_reversal_noop_per_decision" ON "partner_credit_ledger" USING btree ("decision_id") WHERE "partner_credit_ledger"."entry_type" = 'reversal_noop';--> statement-breakpoint
CREATE UNIQUE INDEX "partner_credit_ledger_one_recovery_restored_per_decision" ON "partner_credit_ledger" USING btree ("decision_id") WHERE "partner_credit_ledger"."entry_type" = 'recovery_restored';--> statement-breakpoint
ALTER TABLE "partner_credit_ledger" ADD CONSTRAINT "partner_credit_ledger_r10_units_check" CHECK ("partner_credit_ledger"."entry_type" NOT IN ('reversal_noop','recovery_restored') OR "partner_credit_ledger"."units" = 1);--> statement-breakpoint
ALTER TABLE "partner_credit_ledger" ADD CONSTRAINT "partner_credit_ledger_type_check" CHECK ("partner_credit_ledger"."entry_type" IN ('provisional','vest','expire','reverse','recovery_offset','admin_adjustment','consume','consumed_reversal','reversal_noop','recovery_restored'));
--> statement-breakpoint
-- R10 (revoked-award recovery, Block 1). ADDITIVE, INERT, development only. The two new ledger types are informational (+1) and NOT counted in the ledger identity.
--   reversal_noop     : a reversal closed an EXPIRED lot with no balance effect (the ledger forbids a zero-unit entry).
--   recovery_restored : a reversal reinstated, on the same obligation, the exact offset an offset-consumed credit had paid.
-- Their evidence is verified by the database BEFORE the row exists, so the writer must create the evidence first.
CREATE OR REPLACE FUNCTION partner_credit_ledger_r10_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offset_count integer;
BEGIN
  IF NEW.entry_type = 'reversal_noop' THEN
    IF NEW.decision_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM partner_credit_lots l WHERE l.decision_id = NEW.decision_id AND l.account_id = NEW.account_id AND l.status = 'expired')
       OR NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'expire')
       OR EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.entry_type NOT IN ('provisional','vest','expire'))
       OR EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.decision_id = NEW.decision_id) THEN
      RAISE EXCEPTION 'A no-effect reversal closes only an expired lot that has no reservation and no ledger effect other than provisional, vest and expire';
    END IF;
  ELSIF NEW.entry_type = 'recovery_restored' THEN
    IF NEW.decision_id IS NULL OR NEW.metadata->>'obligationId' IS NULL THEN
      RAISE EXCEPTION 'A recovery restoration names its decision and its obligation';
    END IF;
    SELECT count(*) INTO offset_count FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.entry_type = 'recovery_offset';
    IF offset_count <> 1
       OR NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'recovery_offset'
                       AND g.metadata->>'obligationId' = NEW.metadata->>'obligationId' AND g.units = -NEW.units)
       OR EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.decision_id = NEW.decision_id)
       OR NOT EXISTS (SELECT 1 FROM partner_credit_lots l WHERE l.decision_id = NEW.decision_id AND l.account_id = NEW.account_id AND l.status = 'consumed') THEN
      RAISE EXCEPTION 'A recovery restoration reinstates exactly the one recorded offset of an offset-consumed credit, on the same obligation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER partner_credit_ledger_r10_evidence
 BEFORE INSERT ON partner_credit_ledger
 FOR EACH ROW EXECUTE FUNCTION partner_credit_ledger_r10_evidence();--> statement-breakpoint
-- Lot transitions (replaces the 0057 function): everything of 0053/0057 is unchanged; consumed -> reversed now needs the evidence that matches how the lot was consumed
-- (a consumed reservation needs the consumed_reversal entry; an offset-consumed lot needs the recovery_restored entry), and an expired lot can only become reversed after
-- its reversal_noop entry.
CREATE OR REPLACE FUNCTION partner_credit_lot_consume_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'consumed' AND OLD.status <> 'consumed' THEN
    IF OLD.status = 'reserved' THEN
      IF NOT EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.lot_id = NEW.id AND r.state = 'consumed') THEN
        RAISE EXCEPTION 'A reserved lot is consumed only after its reservation is consumed';
      END IF;
    ELSIF OLD.status = 'provisional' THEN
      IF NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'recovery_offset') THEN
        RAISE EXCEPTION 'A provisional lot becomes consumed only when a recovery offset absorbed its vesting unit';
      END IF;
    ELSE
      RAISE EXCEPTION 'A lot becomes consumed only from reserved (invoice consumption) or provisional (recovery-offset vest)';
    END IF;
  END IF;
  IF OLD.status = 'consumed' AND NEW.status NOT IN ('consumed','reversed') THEN
    RAISE EXCEPTION 'A consumed lot can only be reversed';
  END IF;
  IF OLD.status = 'consumed' AND NEW.status = 'reversed' THEN
    IF EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.lot_id = NEW.id AND r.state = 'consumed') THEN
      IF NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'consumed_reversal') THEN
        RAISE EXCEPTION 'A consumed lot is reversed only after its consumed reversal was recorded';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'recovery_restored') THEN
      RAISE EXCEPTION 'A lot consumed by a recovery-offset vest is reversed only after its recovery restoration was recorded';
    END IF;
  END IF;
  IF OLD.status = 'expired' AND NEW.status <> 'expired' THEN
    IF NEW.status <> 'reversed' OR NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'reversal_noop') THEN
      RAISE EXCEPTION 'An expired lot can only be reversed, and only after its no-effect reversal was recorded';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Recovery obligations: before this migration nothing guarded their updates. The only update is a change of units_outstanding, and it must now equal the due units minus the
-- recorded offsets plus the recorded restorations of that obligation (the writers insert that ledger evidence first), and nothing else about the obligation may change.
CREATE OR REPLACE FUNCTION partner_credit_obligation_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offsets integer; restored integer;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.reversal_ref IS DISTINCT FROM OLD.reversal_ref OR NEW.units_due IS DISTINCT FROM OLD.units_due THEN
    RAISE EXCEPTION 'A recovery obligation is immutable except for its outstanding units';
  END IF;
  IF NEW.units_outstanding IS DISTINCT FROM OLD.units_outstanding THEN
    SELECT COALESCE(SUM(-g.units), 0) INTO offsets FROM partner_credit_ledger g
     WHERE g.entry_type = 'recovery_offset' AND g.account_id = NEW.account_id AND g.metadata->>'obligationId' = NEW.id::text;
    SELECT COALESCE(SUM(g.units), 0) INTO restored FROM partner_credit_ledger g
     WHERE g.entry_type = 'recovery_restored' AND g.account_id = NEW.account_id AND g.metadata->>'obligationId' = NEW.id::text;
    IF NEW.units_outstanding <> NEW.units_due - offsets + restored THEN
      RAISE EXCEPTION 'A recovery obligation outstanding units must equal its due units minus its recorded offsets plus its recorded restorations';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER partner_credit_recovery_obligations_conservation
 BEFORE UPDATE ON partner_credit_recovery_obligations
 FOR EACH ROW EXECUTE FUNCTION partner_credit_obligation_conservation();
