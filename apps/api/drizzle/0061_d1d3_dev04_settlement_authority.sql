-- S08-D1D3-DEV-04 (settlement evidence authenticity and database authority). ADDITIVE, INERT, development only; nothing is activated and no existing guard is removed.
-- The table is inert (every write is denied outside a disposable database), so it is empty wherever this runs; the NOT NULL provenance columns below would fail on rows anyway,
-- and this statement says so clearly instead.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.partner_credit_settlement_authorizations) THEN
    RAISE EXCEPTION 'DEV04: partner_credit_settlement_authorizations is not empty; unsigned DEV-03 evidence cannot be given provenance retroactively';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "partner_credit_settlement_authorizations" ADD COLUMN "provenance_version" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_credit_settlement_authorizations" ADD COLUMN "signing_key_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_credit_settlement_authorizations" ADD COLUMN "signature" text NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_credit_settlement_authorizations" ADD CONSTRAINT "partner_credit_settlement_auth_provenance_check" CHECK ("partner_credit_settlement_authorizations"."provenance_version" = 1 AND "partner_credit_settlement_authorizations"."signing_key_id" ~ '^[A-Za-z0-9._-]{1,64}$' AND "partner_credit_settlement_authorizations"."signature" ~ '^[0-9a-f]{128}$');--> statement-breakpoint
-- ROLES (NOLOGIN group roles only; no login role, password, credential or membership is created here. Production provisioning is a separate owner decision).
--   settlement_recorder          INSERT-only on the evidence table, through the INSERT policy; it may call the read function to see what it recorded
--   settlement_consumer          may only EXECUTE the read function (verify), has no table privilege, so it can verify but never manufacture
--   settlement_authority_reader  internal: owns the SECURITY DEFINER read function and the ledger-gate trigger function; nobody should be made a member
--   settlement_tenant_reader     read-only, restricted by RLS to the tenant named in the session setting echogrid.tenant_id (a READ scope only, see below)
--   settlement_auditor           read-only on every row
-- Migration / administration stays with the table owner, which is deliberately not one of these roles.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['settlement_recorder','settlement_consumer','settlement_authority_reader','settlement_tenant_reader','settlement_auditor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole)) THEN
      RAISE EXCEPTION 'DEV04: role % exists with unsafe attributes (superuser, BYPASSRLS, LOGIN or CREATEROLE); refusing to continue', r;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
REVOKE ALL ON TABLE public.partner_credit_settlement_authorizations FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.partner_credit_settlement_authorizations TO settlement_recorder;--> statement-breakpoint
GRANT SELECT ON TABLE public.partner_credit_settlement_authorizations TO settlement_authority_reader, settlement_tenant_reader, settlement_auditor;--> statement-breakpoint
-- The ledger-gate trigger function (below) runs as settlement_authority_reader and needs to see which reservation carries a decision.
GRANT SELECT ON TABLE public.partner_credit_reservations TO settlement_authority_reader;--> statement-breakpoint
-- ROW LEVEL SECURITY, forced so that even the table owner is subject to it. A superuser or a BYPASSRLS role still bypasses RLS: that is a PostgreSQL property, which is why
-- authenticity does not rest on RLS alone but on the Ed25519 provenance signature verified at consumption (a principal that can bypass RLS still cannot sign).
ALTER TABLE public.partner_credit_settlement_authorizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.partner_credit_settlement_authorizations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY settlement_auth_recorder_insert ON public.partner_credit_settlement_authorizations FOR INSERT TO settlement_recorder WITH CHECK (true);--> statement-breakpoint
CREATE POLICY settlement_auth_authority_select ON public.partner_credit_settlement_authorizations FOR SELECT TO settlement_authority_reader USING (true);--> statement-breakpoint
CREATE POLICY settlement_auth_auditor_select ON public.partner_credit_settlement_authorizations FOR SELECT TO settlement_auditor USING (true);--> statement-breakpoint
-- The tenant setting is only a READ scope. It is not authority: it grants no write, any session may set it, and an unset or foreign value yields only that tenant's evidence or none.
-- Writes are decided by role, by the signature, and by the binding trigger, never by this setting.
CREATE POLICY settlement_auth_tenant_select ON public.partner_credit_settlement_authorizations FOR SELECT TO settlement_tenant_reader
  USING (business_id::text = current_setting('echogrid.tenant_id', true));--> statement-breakpoint
-- The binding trigger reads other tables, so it runs with its definer's rights (the migration owner) and not with the narrow rights of the recorder.
CREATE OR REPLACE FUNCTION public.partner_credit_settlement_auth_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
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
REVOKE ALL ON FUNCTION public.partner_credit_settlement_auth_check() FROM PUBLIC;--> statement-breakpoint
-- The verification read. SECURITY DEFINER with explicit tenant and reservation arguments: a caller that is not entitled to the table can still verify one reservation's evidence,
-- and cannot read, list or write anything else. It returns the newest snapshot, or the named snapshot when a digest is given.
CREATE FUNCTION public.partner_credit_settlement_auth_read(p_business uuid, p_reservation uuid, p_snapshot_digest text DEFAULT NULL)
RETURNS SETOF public.partner_credit_settlement_authorizations LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.* FROM public.partner_credit_settlement_authorizations a
   WHERE a.business_id = p_business AND a.reservation_id = p_reservation AND (p_snapshot_digest IS NULL OR a.snapshot_digest = p_snapshot_digest)
   ORDER BY a.observed_at_ms DESC, a.recorded_at DESC, a.id DESC LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.partner_credit_settlement_auth_read(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
ALTER FUNCTION public.partner_credit_settlement_auth_read(uuid, uuid, text) OWNER TO settlement_authority_reader;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.partner_credit_settlement_auth_read(uuid, uuid, text) TO settlement_consumer, settlement_recorder;--> statement-breakpoint
-- The ledger gate also runs with its own narrow rights, so it keeps working when the consuming session is subject to the forced RLS above.
CREATE OR REPLACE FUNCTION public.partner_credit_ledger_settlement_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.entry_type = 'consume' THEN
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT a.verdict, a.signature FROM partner_credit_settlement_authorizations a JOIN partner_credit_reservations r ON r.id = a.reservation_id AND r.business_id = a.business_id
         WHERE r.decision_id = NEW.decision_id ORDER BY a.observed_at_ms DESC, a.recorded_at DESC, a.id DESC LIMIT 1) newest
       WHERE newest.verdict = 'ELIGIBLE' AND newest.signature IS NOT NULL) THEN
      RAISE EXCEPTION 'SETTLEMENT_GATE: a consume entry needs a current ELIGIBLE settlement authorization for its reservation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.partner_credit_ledger_settlement_gate() FROM PUBLIC;--> statement-breakpoint
ALTER FUNCTION public.partner_credit_ledger_settlement_gate() OWNER TO settlement_authority_reader;
