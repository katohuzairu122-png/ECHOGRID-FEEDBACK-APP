-- Split 08 CE-1 inert evidence foundations. NO billing or Partner Credit activation.
-- These records are only structural; even a stored "applied" row is not
-- authoritative without a separately frozen trusted provider verifier.
CREATE TABLE partner_credit_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 decision_id uuid NOT NULL REFERENCES partner_credit_award_decisions(id) ON DELETE RESTRICT,
 lot_id uuid NOT NULL REFERENCES partner_credit_lots(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL REFERENCES partner_credit_accounts(id) ON DELETE RESTRICT,
 invoice_intent_ref text NOT NULL,
 idempotency_key text NOT NULL UNIQUE,
 units integer NOT NULL DEFAULT 1 CHECK (units = 1),
 state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','released','consumed')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 terminal_at timestamptz,
 CONSTRAINT partner_credit_reservations_lot_key UNIQUE (lot_id),
 CONSTRAINT partner_credit_reservations_invoice_intent_key UNIQUE (business_id, invoice_intent_ref),
 CONSTRAINT partner_credit_reservations_terminal_consistency CHECK (
   (state = 'reserved' AND terminal_at IS NULL) OR
   (state IN ('released','consumed') AND terminal_at IS NOT NULL)
 )
);
--> statement-breakpoint
CREATE INDEX partner_credit_reservations_business_state_idx
 ON partner_credit_reservations(business_id,state);
--> statement-breakpoint
CREATE TABLE billing_partner_credit_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reservation_id uuid NOT NULL UNIQUE REFERENCES partner_credit_reservations(id) ON DELETE RESTRICT,
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 subscription_id uuid NOT NULL REFERENCES business_subscriptions(id) ON DELETE RESTRICT,
 invoice_ref text NOT NULL,
 provider_success_ref text NOT NULL UNIQUE,
 idempotency_key text NOT NULL UNIQUE,
 units_applied integer NOT NULL CHECK (units_applied = 1),
 terminal_state text NOT NULL CHECK (terminal_state = 'applied'),
 applied_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT billing_partner_credit_applications_invoice_once UNIQUE (business_id, invoice_ref)
);
--> statement-breakpoint
CREATE INDEX billing_partner_credit_applications_subscription_idx
 ON billing_partner_credit_applications(subscription_id,applied_at);
--> statement-breakpoint
-- Production application/consumption inserts and updates remain denied.
-- No user/session GUC can toggle this function; isolated disposable CI
-- databases may ALTER TABLE ... DISABLE TRIGGER for constraint tests only.
CREATE OR REPLACE FUNCTION split08_credit_evidence_inert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Split 08 credit reservation/application writes disabled pending CE-1 freeze';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER partner_credit_reservations_inert_guard
 BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_reservations
 FOR EACH ROW EXECUTE FUNCTION split08_credit_evidence_inert_guard();
--> statement-breakpoint
CREATE TRIGGER billing_partner_credit_applications_inert_guard
 BEFORE INSERT OR UPDATE OR DELETE ON billing_partner_credit_applications
 FOR EACH ROW EXECUTE FUNCTION split08_credit_evidence_inert_guard();
