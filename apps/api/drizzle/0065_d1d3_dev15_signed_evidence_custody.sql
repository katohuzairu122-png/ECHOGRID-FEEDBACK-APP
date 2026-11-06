CREATE TABLE "signed_evidence_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "signed_evidence_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"evidence_id" uuid,
	"business_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"reason_code" text NOT NULL,
	"actor_workload_id" text,
	"actor_db_role" text NOT NULL,
	"at_ms" bigint NOT NULL,
	"record_digest" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "signed_evidence_events_type_check" CHECK ("signed_evidence_events"."event_type" IN ('EVIDENCE_PERSISTED','EVIDENCE_REPLAYED','EVIDENCE_CONFLICT_REJECTED','VERIFICATION_ATTEMPTED','VERIFICATION_SUCCEEDED','VERIFICATION_FAILED','KEY_UNAVAILABLE','KEY_REVOKED','ACCESS_DENIED')),
	CONSTRAINT "signed_evidence_events_format_check" CHECK ("signed_evidence_events"."reason_code" ~ '^[A-Z0-9_]{1,64}$' AND "signed_evidence_events"."record_digest" ~ '^[0-9a-f]{64}$' AND "signed_evidence_events"."at_ms" > 0
    AND ("signed_evidence_events"."actor_workload_id" IS NULL OR "signed_evidence_events"."actor_workload_id" ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$'))
);
--> statement-breakpoint
CREATE TABLE "signed_evidence_records" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "signed_evidence_records_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_id" uuid NOT NULL,
	"custodian_workload_id" text NOT NULL,
	"signer_workload_id" text NOT NULL,
	"environment" text NOT NULL,
	"purpose" text NOT NULL,
	"evidence_type" text NOT NULL,
	"schema" text NOT NULL,
	"schema_version" integer NOT NULL,
	"signed_at_ms" bigint NOT NULL,
	"key_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"signature" text NOT NULL,
	"payload_canonical" text NOT NULL,
	"content_digest" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"persisted_by_db_role" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "signed_evidence_records_env_check" CHECK ("signed_evidence_records"."environment" IN ('development','staging','production')),
	CONSTRAINT "signed_evidence_records_purpose_check" CHECK (("signed_evidence_records"."purpose" = 'STRIPE_OBSERVATION_ATTESTATION' AND "signed_evidence_records"."evidence_type" IN ('STRIPE_ACCOUNT_OBSERVATION','STRIPE_INVOICE_OBSERVATION'))
    OR ("signed_evidence_records"."purpose" = 'SYNTHETIC_TEST_EVIDENCE' AND "signed_evidence_records"."evidence_type" = 'SYNTHETIC_TEST_EVIDENCE' AND "signed_evidence_records"."environment" <> 'production')),
	CONSTRAINT "signed_evidence_records_schema_check" CHECK ("signed_evidence_records"."schema" = 'S08-SIGNED-EVIDENCE' AND "signed_evidence_records"."schema_version" = 1 AND "signed_evidence_records"."algorithm" = 'Ed25519' AND "signed_evidence_records"."version" = 1),
	CONSTRAINT "signed_evidence_records_format_check" CHECK ("signed_evidence_records"."payload_sha256" ~ '^[0-9a-f]{64}$' AND "signed_evidence_records"."signature" ~ '^[0-9a-f]{128}$' AND "signed_evidence_records"."content_digest" ~ '^[0-9a-f]{64}$'
    AND "signed_evidence_records"."key_id" ~ '^[A-Za-z0-9._-]{1,64}$' AND "signed_evidence_records"."key_version" >= 1 AND "signed_evidence_records"."signed_at_ms" >= 0 AND "signed_evidence_records"."created_at_ms" > 0
    AND "signed_evidence_records"."custodian_workload_id" ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$' AND "signed_evidence_records"."signer_workload_id" ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$'),
	CONSTRAINT "signed_evidence_records_payload_check" CHECK (octet_length("signed_evidence_records"."payload_canonical") BETWEEN 2 AND 65536 AND encode(sha256(convert_to("signed_evidence_records"."payload_canonical", 'UTF8')), 'hex') = "signed_evidence_records"."payload_sha256")
);
--> statement-breakpoint
ALTER TABLE "signed_evidence_events" ADD CONSTRAINT "signed_evidence_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_evidence_events" ADD CONSTRAINT "signed_evidence_events_evidence_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."signed_evidence_records"("evidence_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_evidence_records" ADD CONSTRAINT "signed_evidence_records_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signed_evidence_events_evidence_idx" ON "signed_evidence_events" USING btree ("evidence_id","seq");--> statement-breakpoint
CREATE INDEX "signed_evidence_events_business_idx" ON "signed_evidence_events" USING btree ("business_id","seq");--> statement-breakpoint
CREATE INDEX "signed_evidence_events_dedupe_idx" ON "signed_evidence_events" USING btree ("evidence_id","event_type","reason_code","actor_workload_id","at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_evidence_records_signature_key" ON "signed_evidence_records" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_evidence_records_seq_key" ON "signed_evidence_records" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "signed_evidence_records_business_idx" ON "signed_evidence_records" USING btree ("business_id","seq");--> statement-breakpoint
-- ===== D1/D3-DEV-15 custom SQL: roles, RLS, immutability, definer functions =====
-- Roles (NOLOGIN groups; the owner provisions logins into them, outside migrations):
--   signed_evidence_lifecycle  owns the definer functions; the ONLY role with table INSERT (under RLS policies)
--   signed_evidence_writer     custody-writing workloads: EXECUTE evidence_custody_persist only
--   signed_evidence_reader     custody-reading workloads: EXECUTE evidence_custody_fetch / evidence_custody_record_verification only
--   signed_evidence_auditor    read-only over both tables
-- No role may UPDATE, DELETE or TRUNCATE; tenant isolation never depends on a session variable (reads are functions taking the tenant explicitly and returning nothing for a foreign record).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['signed_evidence_lifecycle','signed_evidence_writer','signed_evidence_reader','signed_evidence_auditor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole)) THEN
      RAISE EXCEPTION 'DEV15: role % exists with unsafe attributes (superuser, BYPASSRLS, LOGIN or CREATEROLE); refusing to continue', r;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- Same temporary membership/schema grants as migrations 0061/0062/0064 for a migrator that is not a superuser; removed again at the end of this file.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT pg_has_role(current_user, 'signed_evidence_lifecycle', 'SET') THEN
      GRANT signed_evidence_lifecycle TO CURRENT_USER;
      PERFORM set_config('dev15.membership_granted', 'on', false);
    END IF;
    IF NOT has_schema_privilege('signed_evidence_lifecycle', 'public', 'CREATE') THEN
      GRANT CREATE ON SCHEMA public TO signed_evidence_lifecycle;
      PERFORM set_config('dev15.schema_create_granted', 'on', false);
    END IF;
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON TABLE public.signed_evidence_records, public.signed_evidence_events FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.signed_evidence_records, public.signed_evidence_events TO signed_evidence_lifecycle;--> statement-breakpoint
GRANT SELECT ON TABLE public.signed_evidence_records, public.signed_evidence_events TO signed_evidence_auditor;--> statement-breakpoint
ALTER TABLE public.signed_evidence_records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signed_evidence_records FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signed_evidence_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signed_evidence_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY signed_evidence_records_lifecycle_select ON public.signed_evidence_records FOR SELECT TO signed_evidence_lifecycle USING (true);--> statement-breakpoint
CREATE POLICY signed_evidence_records_lifecycle_insert ON public.signed_evidence_records FOR INSERT TO signed_evidence_lifecycle WITH CHECK (true);--> statement-breakpoint
CREATE POLICY signed_evidence_records_auditor_select ON public.signed_evidence_records FOR SELECT TO signed_evidence_auditor USING (true);--> statement-breakpoint
CREATE POLICY signed_evidence_events_lifecycle_select ON public.signed_evidence_events FOR SELECT TO signed_evidence_lifecycle USING (true);--> statement-breakpoint
CREATE POLICY signed_evidence_events_lifecycle_insert ON public.signed_evidence_events FOR INSERT TO signed_evidence_lifecycle WITH CHECK (true);--> statement-breakpoint
CREATE POLICY signed_evidence_events_auditor_select ON public.signed_evidence_events FOR SELECT TO signed_evidence_auditor USING (true);--> statement-breakpoint
-- The foreign keys to businesses are checked as the table owner, so the lifecycle role needs no privilege on businesses.
CREATE FUNCTION public.evidence_custody_now_ms() RETURNS bigint LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$ SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint $$;--> statement-breakpoint
-- Deterministic, length-prefixed (in BYTES) digest over the identity-bearing fields. The application computes the same value; a replay is identical content, anything else is a conflict.
CREATE FUNCTION public.evidence_custody_content_digest(p_business uuid, p_signer text, p_env text, p_purpose text, p_type text, p_schema text, p_schema_version integer, p_signed_at bigint, p_key_id text, p_key_version integer, p_algorithm text, p_payload_sha text, p_signature text, p_payload text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to((SELECT string_agg(octet_length(v)::text || ':' || v || ';', '' ORDER BY ord)
    FROM unnest(ARRAY['S08/SIGNED-EVIDENCE-CUSTODY/1', p_business::text, p_signer, p_env, p_purpose, p_type, p_schema, p_schema_version::text, p_signed_at::text, p_key_id, p_key_version::text, p_algorithm, p_payload_sha, p_signature, p_payload]) WITH ORDINALITY AS t(v, ord)), 'UTF8')), 'hex')
$$;--> statement-breakpoint
CREATE FUNCTION public.evidence_custody_event_digest(p_evidence uuid, p_business uuid, p_type text, p_reason text, p_actor text, p_db_role text, p_at bigint)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to((SELECT string_agg(octet_length(v)::text || ':' || v || ';', '' ORDER BY ord)
    FROM unnest(ARRAY['S08/SIGNED-EVIDENCE-EVENT/1', coalesce(p_evidence::text, ''), p_business::text, p_type, p_reason, coalesce(p_actor, ''), p_db_role, p_at::text]) WITH ORDINALITY AS t(v, ord)), 'UTF8')), 'hex')
$$;--> statement-breakpoint
CREATE FUNCTION public.evidence_custody_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- server-side facts are never taken from the caller
  NEW.version := 1;
  NEW.created_at_ms := public.evidence_custody_now_ms();
  NEW.persisted_by_db_role := session_user;
  NEW.content_digest := public.evidence_custody_content_digest(NEW.business_id, NEW.signer_workload_id, NEW.environment, NEW.purpose, NEW.evidence_type, NEW.schema, NEW.schema_version, NEW.signed_at_ms, NEW.key_id, NEW.key_version, NEW.algorithm, NEW.payload_sha256, NEW.signature, NEW.payload_canonical);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION public.evidence_custody_event_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.evidence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.signed_evidence_records r WHERE r.evidence_id = NEW.evidence_id AND r.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'SIGNED_EVIDENCE_EVENT_TENANT: an event must name the tenant that owns its evidence record';
  END IF;
  NEW.at_ms := public.evidence_custody_now_ms();
  NEW.actor_db_role := session_user;
  NEW.record_digest := public.evidence_custody_event_digest(NEW.evidence_id, NEW.business_id, NEW.event_type, NEW.reason_code, NEW.actor_workload_id, NEW.actor_db_role, NEW.at_ms);
  RETURN NEW;
END $$;--> statement-breakpoint
-- A record can never exist without its PERSISTED custody event: both are written by the same statement's triggers, so a failing audit insert rolls the record back.
CREATE FUNCTION public.evidence_custody_record_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.signed_evidence_events(evidence_id, business_id, event_type, reason_code, actor_workload_id, at_ms, actor_db_role, record_digest)
  VALUES (NEW.evidence_id, NEW.business_id, 'EVIDENCE_PERSISTED', 'STORED', NEW.custodian_workload_id, 1, 'x', repeat('0', 64));
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION public.evidence_custody_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'SIGNED_EVIDENCE_APPEND_ONLY: signed evidence and its custody events are never updated or deleted';
END $$;--> statement-breakpoint
CREATE TRIGGER signed_evidence_records_guard BEFORE INSERT ON public.signed_evidence_records FOR EACH ROW EXECUTE FUNCTION public.evidence_custody_record_guard();--> statement-breakpoint
CREATE TRIGGER signed_evidence_records_audit AFTER INSERT ON public.signed_evidence_records FOR EACH ROW EXECUTE FUNCTION public.evidence_custody_record_audit();--> statement-breakpoint
CREATE TRIGGER signed_evidence_events_guard BEFORE INSERT ON public.signed_evidence_events FOR EACH ROW EXECUTE FUNCTION public.evidence_custody_event_guard();--> statement-breakpoint
CREATE TRIGGER signed_evidence_records_no_update_delete BEFORE UPDATE OR DELETE ON public.signed_evidence_records FOR EACH ROW EXECUTE FUNCTION public.evidence_custody_immutable();--> statement-breakpoint
CREATE TRIGGER signed_evidence_events_no_update_delete BEFORE UPDATE OR DELETE ON public.signed_evidence_events FOR EACH ROW EXECUTE FUNCTION public.evidence_custody_immutable();--> statement-breakpoint
CREATE TRIGGER signed_evidence_records_no_truncate BEFORE TRUNCATE ON public.signed_evidence_records FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
CREATE TRIGGER signed_evidence_events_no_truncate BEFORE TRUNCATE ON public.signed_evidence_events FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.signed_evidence_records ENABLE ALWAYS TRIGGER signed_evidence_records_guard;--> statement-breakpoint
ALTER TABLE public.signed_evidence_records ENABLE ALWAYS TRIGGER signed_evidence_records_audit;--> statement-breakpoint
ALTER TABLE public.signed_evidence_events ENABLE ALWAYS TRIGGER signed_evidence_events_guard;--> statement-breakpoint
ALTER TABLE public.signed_evidence_records ENABLE ALWAYS TRIGGER signed_evidence_records_no_update_delete;--> statement-breakpoint
ALTER TABLE public.signed_evidence_events ENABLE ALWAYS TRIGGER signed_evidence_events_no_update_delete;--> statement-breakpoint
ALTER TABLE public.signed_evidence_records ENABLE ALWAYS TRIGGER signed_evidence_records_no_truncate;--> statement-breakpoint
ALTER TABLE public.signed_evidence_events ENABLE ALWAYS TRIGGER signed_evidence_events_no_truncate;--> statement-breakpoint
-- Internal helper: one bounded custody event (an identical event for the same actor within 60 s is not repeated), tenant-checked by the event guard.
CREATE FUNCTION public.evidence_custody_note(p_evidence uuid, p_business uuid, p_type text, p_reason text, p_actor text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.signed_evidence_events e WHERE e.evidence_id IS NOT DISTINCT FROM p_evidence AND e.business_id = p_business AND e.event_type = p_type AND e.reason_code = p_reason
             AND e.actor_workload_id IS NOT DISTINCT FROM p_actor AND e.at_ms > public.evidence_custody_now_ms() - 60000) THEN
    RETURN false;
  END IF;
  INSERT INTO public.signed_evidence_events(evidence_id, business_id, event_type, reason_code, actor_workload_id, at_ms, actor_db_role, record_digest) VALUES (p_evidence, p_business, p_type, p_reason, p_actor, 1, 'x', repeat('0', 64));
  RETURN true;
END $$;--> statement-breakpoint
-- Persist: idempotent and conflict-safe. Returns PERSISTED, REPLAYED (identical content already stored) or CONFLICT (same id with different content, or the same signature under another id). Never replaces anything.
CREATE FUNCTION public.evidence_custody_persist(p_evidence_id uuid, p_custodian text, p_business uuid, p_signer text, p_env text, p_purpose text, p_type text, p_schema text, p_schema_version integer, p_signed_at bigint, p_key_id text, p_key_version integer, p_algorithm text, p_payload_sha text, p_signature text, p_payload text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_digest text; n integer; ex public.signed_evidence_records%ROWTYPE;
BEGIN
  v_digest := public.evidence_custody_content_digest(p_business, p_signer, p_env, p_purpose, p_type, p_schema, p_schema_version, p_signed_at, p_key_id, p_key_version, p_algorithm, p_payload_sha, p_signature, p_payload);
  INSERT INTO public.signed_evidence_records(evidence_id, business_id, custodian_workload_id, signer_workload_id, environment, purpose, evidence_type, schema, schema_version, signed_at_ms, key_id, key_version, algorithm, payload_sha256, signature, payload_canonical, content_digest, persisted_by_db_role, created_at_ms)
  VALUES (p_evidence_id, p_business, p_custodian, p_signer, p_env, p_purpose, p_type, p_schema, p_schema_version, p_signed_at, p_key_id, p_key_version, p_algorithm, p_payload_sha, p_signature, p_payload, v_digest, 'x', 1)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN RETURN 'PERSISTED'; END IF;
  SELECT * INTO ex FROM public.signed_evidence_records WHERE evidence_id = p_evidence_id;
  IF FOUND AND ex.content_digest = v_digest AND ex.business_id = p_business THEN
    PERFORM public.evidence_custody_note(ex.evidence_id, ex.business_id, 'EVIDENCE_REPLAYED', 'IDENTICAL_REPLAY', p_custodian);
    RETURN 'REPLAYED';
  END IF;
  -- a conflict names the existing record only inside the claimant's own tenant; a foreign record is never referenced
  PERFORM public.evidence_custody_note(CASE WHEN FOUND AND ex.business_id = p_business THEN ex.evidence_id ELSE NULL END, p_business, 'EVIDENCE_CONFLICT_REJECTED', 'CONFLICTING_CONTENT', p_custodian);
  RETURN 'CONFLICT';
END $$;--> statement-breakpoint
-- Fetch: the tenant is an explicit argument checked against the record. A foreign or missing record returns nothing (indistinguishable); a foreign one leaves a bounded ACCESS_DENIED event naming only the claimant tenant.
CREATE FUNCTION public.evidence_custody_fetch(p_business uuid, p_evidence_id uuid, p_actor text) RETURNS SETOF public.signed_evidence_records LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.signed_evidence_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.signed_evidence_records WHERE evidence_id = p_evidence_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF r.business_id <> p_business THEN
    PERFORM public.evidence_custody_note(NULL, p_business, 'ACCESS_DENIED', 'CROSS_TENANT', p_actor);
    RETURN;
  END IF;
  RETURN NEXT r;
END $$;--> statement-breakpoint
-- Verification outcome: ATTEMPTED plus exactly one outcome event, in one call. The record must belong to the named tenant.
CREATE FUNCTION public.evidence_custody_record_verification(p_business uuid, p_evidence uuid, p_actor text, p_outcome text, p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_type text; n integer := 0;
BEGIN
  v_type := CASE p_outcome WHEN 'SUCCEEDED' THEN 'VERIFICATION_SUCCEEDED' WHEN 'FAILED' THEN 'VERIFICATION_FAILED' WHEN 'KEY_UNAVAILABLE' THEN 'KEY_UNAVAILABLE' WHEN 'KEY_REVOKED' THEN 'KEY_REVOKED' ELSE NULL END;
  IF v_type IS NULL THEN RAISE EXCEPTION 'SIGNED_EVIDENCE_OUTCOME: unknown verification outcome'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.signed_evidence_records r WHERE r.evidence_id = p_evidence AND r.business_id = p_business) THEN
    RAISE EXCEPTION 'SIGNED_EVIDENCE_NOT_FOUND: no such evidence in this tenant';
  END IF;
  IF public.evidence_custody_note(p_evidence, p_business, 'VERIFICATION_ATTEMPTED', 'REQUESTED', p_actor) THEN n := n + 1; END IF;
  IF public.evidence_custody_note(p_evidence, p_business, v_type, p_reason, p_actor) THEN n := n + 1; END IF;
  RETURN n;
END $$;--> statement-breakpoint
ALTER FUNCTION public.evidence_custody_record_guard() OWNER TO signed_evidence_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.evidence_custody_event_guard() OWNER TO signed_evidence_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.evidence_custody_record_audit() OWNER TO signed_evidence_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.evidence_custody_note(uuid, uuid, text, text, text) OWNER TO signed_evidence_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.evidence_custody_persist(uuid, text, uuid, text, text, text, text, text, integer, bigint, text, integer, text, text, text, text) OWNER TO signed_evidence_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.evidence_custody_fetch(uuid, uuid, text) OWNER TO signed_evidence_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.evidence_custody_record_verification(uuid, uuid, text, text, text) OWNER TO signed_evidence_lifecycle;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.evidence_custody_now_ms(), public.evidence_custody_content_digest(uuid, text, text, text, text, text, integer, bigint, text, integer, text, text, text, text), public.evidence_custody_event_digest(uuid, uuid, text, text, text, text, bigint),
  public.evidence_custody_record_guard(), public.evidence_custody_event_guard(), public.evidence_custody_record_audit(), public.evidence_custody_immutable(), public.evidence_custody_note(uuid, uuid, text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.evidence_custody_persist(uuid, text, uuid, text, text, text, text, text, integer, bigint, text, integer, text, text, text, text), public.evidence_custody_fetch(uuid, uuid, text), public.evidence_custody_record_verification(uuid, uuid, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.evidence_custody_now_ms(), public.evidence_custody_content_digest(uuid, text, text, text, text, text, integer, bigint, text, integer, text, text, text, text), public.evidence_custody_event_digest(uuid, uuid, text, text, text, text, bigint), public.evidence_custody_note(uuid, uuid, text, text, text) TO signed_evidence_lifecycle;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.evidence_custody_persist(uuid, text, uuid, text, text, text, text, text, integer, bigint, text, integer, text, text, text, text) TO signed_evidence_writer;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.evidence_custody_fetch(uuid, uuid, text), public.evidence_custody_record_verification(uuid, uuid, text, text, text) TO signed_evidence_reader;--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('dev15.schema_create_granted', true) = 'on' THEN REVOKE CREATE ON SCHEMA public FROM signed_evidence_lifecycle; END IF;
  IF current_setting('dev15.membership_granted', true) = 'on' THEN REVOKE signed_evidence_lifecycle FROM CURRENT_USER; END IF;
  PERFORM set_config('dev15.schema_create_granted', '', false);
  PERFORM set_config('dev15.membership_granted', '', false);
END $$;
