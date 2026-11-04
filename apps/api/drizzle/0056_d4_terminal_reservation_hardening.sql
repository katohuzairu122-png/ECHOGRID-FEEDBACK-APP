-- Hardens the 0053 reservation trigger with the two LOW findings the independent reviews left open. ADDITIVE, INERT, development only; CREATE OR REPLACE of one function, the
-- trigger and every other object are untouched.
--
-- 1. terminal_at >= applied_at in the database. 0053 only stamped terminal_at = max(now, applied_at) in the consumer, so a raw UPDATE could consume a reservation with
--    terminal_at earlier than its application's applied_at, a state the integrity readers (ce1-tenant-integrity.verifier, partner-credit-application-integrity.reader) reject.
--    The reserved -> consumed transition now also requires terminal_at >= the application's applied_at.
-- 2. A consumed or released reservation is now immutable in id, idempotency_key and created_at as well (0053 froze every other column).
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
       NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.business_id IS DISTINCT FROM OLD.business_id OR
       NEW.id IS DISTINCT FROM OLD.id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
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
    IF NEW.terminal_at IS NULL OR NEW.terminal_at < (SELECT a.applied_at FROM billing_partner_credit_applications a WHERE a.reservation_id = NEW.id) THEN
      RAISE EXCEPTION 'A consumed reservation cannot be terminal before its application was applied';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
