CREATE TABLE "partner_credit_settlement_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"invoice_ref" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_mode" text NOT NULL,
	"allocation_digest" text NOT NULL,
	"policy_version" text NOT NULL,
	"verdict" text NOT NULL,
	"reason_codes" text[] NOT NULL,
	"classifier_version" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"billing_interval" text NOT NULL,
	"snapshot_ref" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"observed_at_ms" bigint NOT NULL,
	"evidence_digest" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "partner_credit_settlement_auth_replay_key" UNIQUE("reservation_id","snapshot_digest"),
	CONSTRAINT "partner_credit_settlement_auth_provider_mode_check" CHECK ("partner_credit_settlement_authorizations"."provider_mode" IN ('test','live')),
	CONSTRAINT "partner_credit_settlement_auth_verdict_check" CHECK ("partner_credit_settlement_authorizations"."verdict" IN ('ELIGIBLE','INELIGIBLE','UNRESOLVED')),
	CONSTRAINT "partner_credit_settlement_auth_interval_check" CHECK ("partner_credit_settlement_authorizations"."billing_interval" IN ('month','year','unknown')),
	CONSTRAINT "partner_credit_settlement_auth_evidence_kind_check" CHECK ("partner_credit_settlement_authorizations"."evidence_kind" = 'MOCK_SYNTHETIC'),
	CONSTRAINT "partner_credit_settlement_auth_digests_check" CHECK ("partner_credit_settlement_authorizations"."allocation_digest" ~ '^[0-9a-f]{64}$' AND "partner_credit_settlement_authorizations"."snapshot_digest" ~ '^[0-9a-f]{64}$' AND "partner_credit_settlement_authorizations"."evidence_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "partner_credit_settlement_auth_refs_check" CHECK ("partner_credit_settlement_authorizations"."invoice_ref" ~ '^[!-~]{1,255}$' AND "partner_credit_settlement_authorizations"."provider_account_id" ~ '^[!-~]{1,255}$' AND "partner_credit_settlement_authorizations"."policy_version" ~ '^[!-~]{1,255}$' AND "partner_credit_settlement_authorizations"."classifier_version" ~ '^[!-~]{1,255}$' AND "partner_credit_settlement_authorizations"."snapshot_ref" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "partner_credit_settlement_auth_observed_check" CHECK ("partner_credit_settlement_authorizations"."observed_at_ms" > 0),
	CONSTRAINT "partner_credit_settlement_auth_reasons_check" CHECK (cardinality("partner_credit_settlement_authorizations"."reason_codes") >= 1 AND array_to_string("partner_credit_settlement_authorizations"."reason_codes", ',') ~ '^[A-Z_]+(,[A-Z_]+)*$'),
	CONSTRAINT "partner_credit_settlement_auth_verdict_reason_check" CHECK (("partner_credit_settlement_authorizations"."verdict" = 'ELIGIBLE' AND "partner_credit_settlement_authorizations"."reason_codes" = ARRAY['ALL_CONDITIONS_VERIFIED']::text[]) OR ("partner_credit_settlement_authorizations"."verdict" <> 'ELIGIBLE' AND NOT ('ALL_CONDITIONS_VERIFIED' = ANY("partner_credit_settlement_authorizations"."reason_codes"))))
);
--> statement-breakpoint
ALTER TABLE "partner_credit_settlement_authorizations" ADD CONSTRAINT "partner_credit_settlement_authorizations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_settlement_authorizations" ADD CONSTRAINT "partner_credit_settlement_auth_reservation_fk" FOREIGN KEY ("reservation_id","business_id") REFERENCES "public"."partner_credit_reservations"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_credit_settlement_auth_latest_idx" ON "partner_credit_settlement_authorizations" USING btree ("reservation_id","observed_at_ms","recorded_at","id");--> statement-breakpoint
-- S08-D1D3-DEV-03 (settlement gate). ADDITIVE, INERT, development only; no existing row, column, constraint or trigger is changed and nothing is activated.
--
-- A settlement authorization is EVIDENCE of what the pure settlement classifier concluded about one reservation from one evidence snapshot. This migration makes the
-- evidence append-only, makes the database recompute its integrity digest, binds it to the reservation, decision, invoice and persisted frozen allocation it names,
-- and refuses a `consume` ledger entry unless the newest authorization for that reservation is ELIGIBLE. Freshness, the expected Stripe account and mode and the allowed
-- billing intervals are CONFIGURATION that the consumption transaction enforces; they are deliberately not frozen into the database as policy.
--
-- Canonical digest (identical in TypeScript and here): sha256 over, for each field in order, <character length>:<value>; (refs are restricted to printable ASCII).
-- Fields: label, business_id, reservation_id, decision_id, invoice_ref, provider_account_id, provider_mode, allocation_digest, policy_version, verdict,
-- reason_codes joined by comma, classifier_version, evidence_kind, billing_interval, snapshot_ref, snapshot_digest, observed_at_ms.
CREATE FUNCTION public.partner_credit_settlement_auth_digest(
  p_business uuid, p_reservation uuid, p_decision uuid, p_invoice text, p_account text, p_mode text, p_allocation text, p_policy text, p_verdict text, p_reasons text[],
  p_classifier text, p_kind text, p_interval text, p_snapshot_ref text, p_snapshot_digest text, p_observed bigint)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(
    (SELECT string_agg(char_length(v) || ':' || v || ';', '' ORDER BY n) FROM unnest(ARRAY[
      'ECHO-GRID:S08-SETTLEMENT-AUTH/1', p_business::text, p_reservation::text, p_decision::text, p_invoice, p_account, p_mode, p_allocation, p_policy, p_verdict,
      array_to_string(p_reasons, ','), p_classifier, p_kind, p_interval, p_snapshot_ref, p_snapshot_digest, p_observed::text]) WITH ORDINALITY AS t(v, n)),
    'UTF8')), 'hex')
$$;--> statement-breakpoint
CREATE FUNCTION public.partner_credit_settlement_auth_check() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.evidence_digest IS DISTINCT FROM public.partner_credit_settlement_auth_digest(NEW.business_id, NEW.reservation_id, NEW.decision_id, NEW.invoice_ref, NEW.provider_account_id,
       NEW.provider_mode, NEW.allocation_digest, NEW.policy_version, NEW.verdict, NEW.reason_codes, NEW.classifier_version, NEW.evidence_kind, NEW.billing_interval,
       NEW.snapshot_ref, NEW.snapshot_digest, NEW.observed_at_ms) THEN
    RAISE EXCEPTION 'SETTLEMENT_AUTH_DIGEST_MISMATCH: the integrity digest does not match the recorded fields';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.id = NEW.reservation_id AND r.business_id = NEW.business_id AND r.decision_id = NEW.decision_id) THEN
    RAISE EXCEPTION 'SETTLEMENT_AUTH_BINDING: the business, reservation and decision do not belong together';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM benefit_application_intents i WHERE i.reservation_id = NEW.reservation_id AND i.business_id = NEW.business_id AND i.invoice_ref = NEW.invoice_ref AND i.policy_version = NEW.policy_version) THEN
    RAISE EXCEPTION 'SETTLEMENT_AUTH_BINDING: the invoice and policy are not those of the reservation''s application intent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM s08_allocation_freezes f JOIN s08_allocation_freeze_items it ON it.freeze_id = f.id AND it.business_id = f.business_id
                  WHERE f.business_id = NEW.business_id AND f.invoice_ref = NEW.invoice_ref AND f.allocation_digest = NEW.allocation_digest AND it.reservation_id = NEW.reservation_id) THEN
    RAISE EXCEPTION 'SETTLEMENT_AUTH_BINDING: the allocation digest is not that of the persisted freeze containing this reservation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER partner_credit_settlement_authorizations_check BEFORE INSERT ON public.partner_credit_settlement_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.partner_credit_settlement_auth_check();--> statement-breakpoint
CREATE FUNCTION public.partner_credit_settlement_auth_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'SETTLEMENT_AUTH_APPEND_ONLY: settlement authorization evidence is never updated or deleted';
END $$;--> statement-breakpoint
CREATE TRIGGER partner_credit_settlement_authorizations_no_update_delete BEFORE UPDATE OR DELETE ON public.partner_credit_settlement_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.partner_credit_settlement_auth_immutable();--> statement-breakpoint
ALTER TABLE public.partner_credit_settlement_authorizations ENABLE ALWAYS TRIGGER partner_credit_settlement_authorizations_no_update_delete;--> statement-breakpoint
CREATE TRIGGER partner_credit_settlement_authorizations_no_truncate BEFORE TRUNCATE ON public.partner_credit_settlement_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_settlement_authorizations ENABLE ALWAYS TRIGGER partner_credit_settlement_authorizations_no_truncate;--> statement-breakpoint
-- Inert like the other Split 08 evidence tables: writes are denied unless an isolated disposable database disables this trigger.
CREATE FUNCTION public.partner_credit_settlement_auth_inert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Split 08 settlement authorization writes disabled pending the Stripe evidence decisions';
END $$;--> statement-breakpoint
CREATE TRIGGER partner_credit_settlement_authorizations_inert_guard BEFORE INSERT ON public.partner_credit_settlement_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.partner_credit_settlement_auth_inert_guard();--> statement-breakpoint
-- Defense in depth: even a writer that bypasses the service cannot append a `consume` ledger entry unless the NEWEST authorization (by observation time, then insertion)
-- of the reservation that carries this decision is ELIGIBLE. Freshness and account/mode are enforced by the consumption transaction, which owns the configuration.
CREATE FUNCTION public.partner_credit_ledger_settlement_gate() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.entry_type = 'consume' THEN
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT a.verdict FROM partner_credit_settlement_authorizations a JOIN partner_credit_reservations r ON r.id = a.reservation_id AND r.business_id = a.business_id
         WHERE r.decision_id = NEW.decision_id ORDER BY a.observed_at_ms DESC, a.recorded_at DESC, a.id DESC LIMIT 1) newest
       WHERE newest.verdict = 'ELIGIBLE') THEN
      RAISE EXCEPTION 'SETTLEMENT_GATE: a consume entry needs a current ELIGIBLE settlement authorization for its reservation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER partner_credit_ledger_settlement_gate BEFORE INSERT ON public.partner_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.partner_credit_ledger_settlement_gate();
