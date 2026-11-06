-- DEV-20.B: additive, inert, immutable custody-to-authorization link.
-- No legacy authorization is upgraded or treated as custody-linked.
-- The two composite foreign keys enforce exact tenant and immutable stored
-- digest/key metadata without granting the recorder SELECT on custody.
ALTER TABLE public.signed_evidence_records
  ADD CONSTRAINT signed_evidence_records_dev20_binding_key
  UNIQUE (evidence_id, business_id, payload_sha256, key_id, key_version);
--> statement-breakpoint
ALTER TABLE public.partner_credit_settlement_authorizations
  ADD CONSTRAINT settlement_auth_dev20_binding_key
  UNIQUE (id, business_id, reservation_id, evidence_digest);
--> statement-breakpoint
CREATE TABLE public.settlement_custody_authorization_links (
  authorization_id uuid PRIMARY KEY NOT NULL,
  evidence_id uuid NOT NULL,
  business_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  payload_sha256 text NOT NULL,
  custody_key_id text NOT NULL,
  custody_key_version integer NOT NULL,
  authorization_evidence_digest text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT settlement_custody_link_one_evidence UNIQUE (evidence_id),
  CONSTRAINT settlement_custody_link_hash_check CHECK (payload_sha256 ~ '^[0-9a-f]{64}$' AND authorization_evidence_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT settlement_custody_link_key_check CHECK (custody_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND custody_key_version >= 1),
  CONSTRAINT settlement_custody_link_auth_fk FOREIGN KEY
    (authorization_id, business_id, reservation_id, authorization_evidence_digest)
    REFERENCES public.partner_credit_settlement_authorizations(id, business_id, reservation_id, evidence_digest)
    ON DELETE RESTRICT,
  CONSTRAINT settlement_custody_link_custody_fk FOREIGN KEY
    (evidence_id, business_id, payload_sha256, custody_key_id, custody_key_version)
    REFERENCES public.signed_evidence_records(evidence_id, business_id, payload_sha256, key_id, key_version)
    ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX settlement_custody_link_business_idx ON public.settlement_custody_authorization_links (business_id, reservation_id);
--> statement-breakpoint
CREATE FUNCTION public.settlement_custody_link_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'DEV20_LINK_APPEND_ONLY: custody authorization links cannot be modified';
END $$;
--> statement-breakpoint
CREATE TRIGGER settlement_custody_link_no_update_delete
  BEFORE UPDATE OR DELETE ON public.settlement_custody_authorization_links
  FOR EACH ROW EXECUTE FUNCTION public.settlement_custody_link_immutable();
--> statement-breakpoint
ALTER TABLE public.settlement_custody_authorization_links ENABLE ALWAYS TRIGGER settlement_custody_link_no_update_delete;
--> statement-breakpoint
CREATE TRIGGER settlement_custody_link_no_truncate
  BEFORE TRUNCATE ON public.settlement_custody_authorization_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();
--> statement-breakpoint
ALTER TABLE public.settlement_custody_authorization_links ENABLE ALWAYS TRIGGER settlement_custody_link_no_truncate;
--> statement-breakpoint
-- Preserve the existing default-deny settlement-authorizations insertion
-- guard. The sidecar also has an explicit inert guard until a disposable
-- development test turns it off.
CREATE FUNCTION public.settlement_custody_link_inert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'DEV20_LINK_INERT: custody authorization linkage disabled';
END $$;
--> statement-breakpoint
CREATE TRIGGER settlement_custody_link_inert_guard
  BEFORE INSERT ON public.settlement_custody_authorization_links
  FOR EACH ROW EXECUTE FUNCTION public.settlement_custody_link_inert();
--> statement-breakpoint
REVOKE ALL ON public.settlement_custody_authorization_links FROM PUBLIC;
--> statement-breakpoint
GRANT INSERT ON public.settlement_custody_authorization_links TO settlement_recorder;
--> statement-breakpoint
GRANT SELECT ON public.settlement_custody_authorization_links TO settlement_authority_reader, settlement_auditor;
--> statement-breakpoint
ALTER TABLE public.settlement_custody_authorization_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.settlement_custody_authorization_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY settlement_custody_link_recorder_insert ON public.settlement_custody_authorization_links
  FOR INSERT TO settlement_recorder WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY settlement_custody_link_authority_read ON public.settlement_custody_authorization_links
  FOR SELECT TO settlement_authority_reader USING (true);
--> statement-breakpoint
CREATE POLICY settlement_custody_link_auditor_read ON public.settlement_custody_authorization_links
  FOR SELECT TO settlement_auditor USING (true);
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.settlement_custody_link_immutable(),
  public.settlement_custody_link_inert() FROM PUBLIC;

--> statement-breakpoint
-- Narrow replay verification: recorder can check the EXACT link it already
-- knows, but cannot enumerate other tenants' link rows.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT pg_has_role(current_user, 'settlement_authority_reader', 'SET') THEN
      GRANT settlement_authority_reader TO CURRENT_USER;
      PERFORM set_config('dev20b.membership_granted', 'on', false);
    END IF;
    IF NOT has_schema_privilege('settlement_authority_reader', 'public', 'CREATE') THEN
      GRANT CREATE ON SCHEMA public TO settlement_authority_reader;
      PERFORM set_config('dev20b.schema_create_granted', 'on', false);
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.settlement_custody_link_matches(
  p_auth uuid, p_business uuid, p_reservation uuid, p_evidence uuid,
  p_payload text, p_key text, p_version integer, p_digest text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT EXISTS (
   SELECT 1 FROM public.settlement_custody_authorization_links l
    WHERE l.authorization_id = p_auth AND l.business_id = p_business
      AND l.reservation_id = p_reservation AND l.evidence_id = p_evidence
      AND l.payload_sha256 = p_payload AND l.custody_key_id = p_key
      AND l.custody_key_version = p_version AND l.authorization_evidence_digest = p_digest
 )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.settlement_custody_link_matches(uuid,uuid,uuid,uuid,text,text,integer,text) FROM PUBLIC;
--> statement-breakpoint
ALTER FUNCTION public.settlement_custody_link_matches(uuid,uuid,uuid,uuid,text,text,integer,text)
  OWNER TO settlement_authority_reader;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.settlement_custody_link_matches(uuid,uuid,uuid,uuid,text,text,integer,text)
 TO settlement_recorder;
--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('dev20b.schema_create_granted', true) = 'on' THEN
    REVOKE CREATE ON SCHEMA public FROM settlement_authority_reader;
  END IF;
  IF current_setting('dev20b.membership_granted', true) = 'on' THEN
    REVOKE settlement_authority_reader FROM CURRENT_USER;
  END IF;
  PERFORM set_config('dev20b.schema_create_granted', '', false);
  PERFORM set_config('dev20b.membership_granted', '', false);
END $$;
