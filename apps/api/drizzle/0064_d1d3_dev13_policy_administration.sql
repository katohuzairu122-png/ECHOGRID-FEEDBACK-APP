CREATE TABLE "stripe_read_policy_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "stripe_read_policy_changes_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"expected_policy_version" integer NOT NULL,
	"target_state" boolean NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"justification" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"decided_by" uuid,
	"decided_at_ms" bigint,
	"decision_ref" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "stripe_read_policy_change_state_check" CHECK ("stripe_read_policy_changes"."state" IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED')),
	CONSTRAINT "stripe_read_policy_change_text_check" CHECK ("stripe_read_policy_changes"."justification" ~ '^[ -~]{1,255}$'),
	CONSTRAINT "stripe_read_policy_change_window_check" CHECK ("stripe_read_policy_changes"."expected_policy_version" >= 1 AND "stripe_read_policy_changes"."version" >= 1 AND "stripe_read_policy_changes"."expires_at_ms" > 0),
	CONSTRAINT "stripe_read_policy_change_fields_check" CHECK (("stripe_read_policy_changes"."state" = 'PENDING' AND "stripe_read_policy_changes"."decided_by" IS NULL AND "stripe_read_policy_changes"."decided_at_ms" IS NULL AND "stripe_read_policy_changes"."decision_ref" IS NULL)
    OR ("stripe_read_policy_changes"."state" <> 'PENDING' AND "stripe_read_policy_changes"."decided_by" IS NOT NULL AND "stripe_read_policy_changes"."decided_at_ms" IS NOT NULL AND "stripe_read_policy_changes"."decision_ref" IS NOT NULL AND "stripe_read_policy_changes"."decision_ref" ~ '^[!-~]{1,255}$'))
);
--> statement-breakpoint
CREATE TABLE "stripe_read_policy_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stripe_read_policy_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"change_id" uuid,
	"version" integer NOT NULL,
	"event_type" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_id" uuid,
	"actor_db_role" text,
	"decision_ref" text,
	"policy_version" integer NOT NULL,
	"at_ms" bigint NOT NULL,
	"record_digest" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "stripe_read_policy_events_type_check" CHECK ("stripe_read_policy_events"."event_type" IN ('PROPOSED','APPROVED','REJECTED','CANCELLED','EXPIRED','POLICY_ROW_CREATED','POLICY_VALUE_CHANGED')),
	CONSTRAINT "stripe_read_policy_events_actor_check" CHECK (("stripe_read_policy_events"."change_id" IS NOT NULL AND "stripe_read_policy_events"."actor_id" IS NOT NULL) OR ("stripe_read_policy_events"."change_id" IS NULL AND "stripe_read_policy_events"."actor_db_role" IS NOT NULL)),
	CONSTRAINT "stripe_read_policy_events_digest_check" CHECK ("stripe_read_policy_events"."record_digest" ~ '^[0-9a-f]{64}$' AND "stripe_read_policy_events"."version" >= 1 AND "stripe_read_policy_events"."policy_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "stripe_read_authorization_policy" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_read_policy_changes" ADD CONSTRAINT "stripe_read_policy_changes_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_policy_changes" ADD CONSTRAINT "stripe_read_policy_changes_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_policy_events" ADD CONSTRAINT "stripe_read_policy_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_policy_events" ADD CONSTRAINT "stripe_read_policy_events_change_fk" FOREIGN KEY ("change_id") REFERENCES "public"."stripe_read_policy_changes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_read_policy_change_live_key" ON "stripe_read_policy_changes" USING btree ("expected_policy_version") WHERE "stripe_read_policy_changes"."state" IN ('PENDING','APPROVED');--> statement-breakpoint
CREATE INDEX "stripe_read_policy_change_seq_idx" ON "stripe_read_policy_changes" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "stripe_read_policy_events_change_idx" ON "stripe_read_policy_events" USING btree ("change_id","seq");--> statement-breakpoint

-- S08-D1D3-DEV-13 (policy administration). ADDITIVE, INERT, development only. Reuses the DEV-10 roles; creates none. NOTHING in this file applies a policy-change request to the policy: approving a request only records
-- a dual-administrator decision. `approval_enabled` stays FALSE and remains owner-controlled and out of band.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT pg_has_role(current_user, 'stripe_read_auth_lifecycle', 'SET') THEN
      GRANT stripe_read_auth_lifecycle TO CURRENT_USER;
      PERFORM set_config('dev13.membership_granted', 'on', false);
    END IF;
    IF NOT has_schema_privilege('stripe_read_auth_lifecycle', 'public', 'CREATE') THEN
      GRANT CREATE ON SCHEMA public TO stripe_read_auth_lifecycle;
      PERFORM set_config('dev13.schema_create_granted', 'on', false);
    END IF;
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON TABLE public.stripe_read_policy_changes, public.stripe_read_policy_events FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.stripe_read_policy_changes TO stripe_read_auth_lifecycle;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.stripe_read_policy_events TO stripe_read_auth_lifecycle;--> statement-breakpoint
GRANT SELECT ON TABLE public.stripe_read_policy_changes, public.stripe_read_policy_events TO stripe_read_auth_auditor;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_changes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_changes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY read_policy_changes_lifecycle_select ON public.stripe_read_policy_changes FOR SELECT TO stripe_read_auth_lifecycle USING (true);--> statement-breakpoint
CREATE POLICY read_policy_changes_lifecycle_insert ON public.stripe_read_policy_changes FOR INSERT TO stripe_read_auth_lifecycle WITH CHECK (true);--> statement-breakpoint
CREATE POLICY read_policy_changes_lifecycle_update ON public.stripe_read_policy_changes FOR UPDATE TO stripe_read_auth_lifecycle USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY read_policy_changes_auditor_select ON public.stripe_read_policy_changes FOR SELECT TO stripe_read_auth_auditor USING (true);--> statement-breakpoint
CREATE POLICY read_policy_events_lifecycle_select ON public.stripe_read_policy_events FOR SELECT TO stripe_read_auth_lifecycle USING (true);--> statement-breakpoint
CREATE POLICY read_policy_events_lifecycle_insert ON public.stripe_read_policy_events FOR INSERT TO stripe_read_auth_lifecycle WITH CHECK (true);--> statement-breakpoint
CREATE POLICY read_policy_events_auditor_select ON public.stripe_read_policy_events FOR SELECT TO stripe_read_auth_auditor USING (true);--> statement-breakpoint
-- Canonical digests (length-prefixed, versioned) recorded in the audit trail.
CREATE FUNCTION public.stripe_read_policy_change_digest(r public.stripe_read_policy_changes) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to((SELECT string_agg(char_length(v) || ':' || v || ';', '' ORDER BY n) FROM unnest(ARRAY[
    'ECHO-GRID:S08-READ-POLICY-CHANGE/1', r.id::text, r.expected_policy_version::text, r.target_state::text, r.state, r.version::text, r.justification, r.proposed_by::text, r.expires_at_ms::text,
    coalesce(r.decided_by::text, ''), coalesce(r.decided_at_ms::text, ''), coalesce(r.decision_ref, '')]) WITH ORDINALITY AS t(v, n)), 'UTF8')), 'hex')
$$;--> statement-breakpoint
CREATE FUNCTION public.stripe_read_policy_row_digest(p_enabled boolean, p_version integer) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to('ECHO-GRID:S08-READ-POLICY/1|' || p_enabled::text || '|' || p_version::text, 'UTF8')), 'hex')
$$;--> statement-breakpoint
-- The POLICY row: its version advances by exactly one whenever approval_enabled changes and can be set by nobody else; every creation or change is audited with the database session user (an out-of-band owner change has no administrator).
CREATE FUNCTION public.stripe_read_policy_row_before() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN RAISE EXCEPTION 'READ_POLICY_IMMUTABLE: the policy row identity is never changed'; END IF;
    IF NEW.approval_enabled IS DISTINCT FROM OLD.approval_enabled THEN NEW.version := OLD.version + 1; ELSE NEW.version := OLD.version; END IF;
  ELSE
    NEW.version := 1;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER stripe_read_authorization_policy_row_before BEFORE INSERT OR UPDATE ON public.stripe_read_authorization_policy FOR EACH ROW EXECUTE FUNCTION public.stripe_read_policy_row_before();--> statement-breakpoint
CREATE FUNCTION public.stripe_read_policy_row_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.stripe_read_policy_events (change_id, version, event_type, from_state, to_state, actor_id, actor_db_role, decision_ref, policy_version, at_ms, record_digest)
    VALUES (NULL, NEW.version, 'POLICY_ROW_CREATED', NULL, CASE WHEN NEW.approval_enabled THEN 'ENABLED' ELSE 'DISABLED' END, NULL, session_user::text, NULL, NEW.version, public.stripe_read_auth_now_ms(), public.stripe_read_policy_row_digest(NEW.approval_enabled, NEW.version));
  ELSIF NEW.approval_enabled IS DISTINCT FROM OLD.approval_enabled THEN
    INSERT INTO public.stripe_read_policy_events (change_id, version, event_type, from_state, to_state, actor_id, actor_db_role, decision_ref, policy_version, at_ms, record_digest)
    VALUES (NULL, NEW.version, 'POLICY_VALUE_CHANGED', CASE WHEN OLD.approval_enabled THEN 'ENABLED' ELSE 'DISABLED' END, CASE WHEN NEW.approval_enabled THEN 'ENABLED' ELSE 'DISABLED' END, NULL, session_user::text, NULL, NEW.version, public.stripe_read_auth_now_ms(), public.stripe_read_policy_row_digest(NEW.approval_enabled, NEW.version));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER stripe_read_authorization_policy_row_audit AFTER INSERT OR UPDATE ON public.stripe_read_authorization_policy FOR EACH ROW EXECUTE FUNCTION public.stripe_read_policy_row_audit();--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_policy ENABLE ALWAYS TRIGGER stripe_read_authorization_policy_row_before;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_policy ENABLE ALWAYS TRIGGER stripe_read_authorization_policy_row_audit;--> statement-breakpoint
-- THE GUARD for policy-change requests. It runs for every writer. It never reads or writes approval_enabled except to compare against it.
CREATE FUNCTION public.stripe_read_policy_change_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE now_ms bigint := public.stripe_read_auth_now_ms(); pv integer; pe boolean;
BEGIN
  SELECT p.version, p.approval_enabled INTO pv, pe FROM public.stripe_read_authorization_policy p WHERE p.singleton;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' OR NEW.version <> 1 THEN RAISE EXCEPTION 'READ_POLICY_INSERT_NOT_PENDING: a policy-change request is created PENDING at version 1'; END IF;
    IF NOT public.stripe_read_auth_is_admin(NEW.proposed_by) THEN RAISE EXCEPTION 'READ_POLICY_ADMIN_REQUIRED: the proposer must be an active platform administrator'; END IF;
    IF pv IS NULL THEN RAISE EXCEPTION 'READ_POLICY_MISSING: the policy row is missing, so no request can be made'; END IF;
    IF NEW.expected_policy_version <> pv THEN RAISE EXCEPTION 'READ_POLICY_VERSION_CONFLICT: the request names policy version % but the policy is at version %', NEW.expected_policy_version, pv; END IF;
    IF NEW.target_state IS NOT DISTINCT FROM pe THEN RAISE EXCEPTION 'READ_POLICY_NO_CHANGE: the requested state is already the current policy state'; END IF;
    IF NEW.expires_at_ms <= now_ms THEN RAISE EXCEPTION 'READ_POLICY_EXPIRED: a request cannot be created already expired'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.seq <> OLD.seq OR NEW.expected_policy_version <> OLD.expected_policy_version OR NEW.target_state <> OLD.target_state OR NEW.justification <> OLD.justification
     OR NEW.proposed_by <> OLD.proposed_by OR NEW.expires_at_ms <> OLD.expires_at_ms OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'READ_POLICY_IMMUTABLE: the content of a policy-change request is never changed';
  END IF;
  IF OLD.state <> 'PENDING' THEN RAISE EXCEPTION 'READ_POLICY_TERMINAL: a decided request is never changed or reopened'; END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'READ_POLICY_VERSION: the request version must advance by exactly one'; END IF;
  IF NEW.decided_by IS NULL OR NOT public.stripe_read_auth_is_admin(NEW.decided_by) THEN RAISE EXCEPTION 'READ_POLICY_ADMIN_REQUIRED: the deciding administrator must be an active platform administrator'; END IF;
  NEW.decided_at_ms := now_ms;
  IF NEW.state = 'EXPIRED' THEN
    IF now_ms < OLD.expires_at_ms THEN RAISE EXCEPTION 'READ_POLICY_NOT_EXPIRED: the request has not expired'; END IF;
    NEW.decision_ref := 'EXPIRED';
    RETURN NEW;
  END IF;
  IF now_ms >= OLD.expires_at_ms THEN RAISE EXCEPTION 'READ_POLICY_EXPIRED: an expired request can only be recorded as expired'; END IF;
  IF NEW.state IN ('APPROVED', 'REJECTED') THEN
    IF NEW.decided_by = OLD.proposed_by THEN RAISE EXCEPTION 'READ_POLICY_SELF_DECISION: the proposer cannot approve or reject their own request'; END IF;
  ELSIF NEW.state <> 'CANCELLED' THEN
    RAISE EXCEPTION 'READ_POLICY_INVALID_TRANSITION: PENDING -> % is not a permitted transition', NEW.state;
  END IF;
  IF NEW.state = 'APPROVED' AND (pv IS NULL OR pv <> OLD.expected_policy_version) THEN RAISE EXCEPTION 'READ_POLICY_VERSION_CONFLICT: the policy changed since the request was written; it cannot be approved'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER stripe_read_policy_changes_guard BEFORE INSERT OR UPDATE ON public.stripe_read_policy_changes FOR EACH ROW EXECUTE FUNCTION public.stripe_read_policy_change_guard();--> statement-breakpoint
CREATE FUNCTION public.stripe_read_policy_change_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pv integer;
BEGIN
  SELECT p.version INTO pv FROM public.stripe_read_authorization_policy p WHERE p.singleton;
  INSERT INTO public.stripe_read_policy_events (change_id, version, event_type, from_state, to_state, actor_id, actor_db_role, decision_ref, policy_version, at_ms, record_digest)
  VALUES (NEW.id, NEW.version, CASE WHEN TG_OP = 'INSERT' THEN 'PROPOSED' ELSE NEW.state END, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END, NEW.state,
          CASE WHEN TG_OP = 'INSERT' THEN NEW.proposed_by ELSE NEW.decided_by END, NULL, NEW.decision_ref, coalesce(pv, NEW.expected_policy_version),
          CASE WHEN TG_OP = 'INSERT' THEN public.stripe_read_auth_now_ms() ELSE NEW.decided_at_ms END, public.stripe_read_policy_change_digest(NEW));
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER stripe_read_policy_changes_audit AFTER INSERT OR UPDATE ON public.stripe_read_policy_changes FOR EACH ROW EXECUTE FUNCTION public.stripe_read_policy_change_audit();--> statement-breakpoint
CREATE TRIGGER stripe_read_policy_changes_no_delete BEFORE DELETE ON public.stripe_read_policy_changes FOR EACH ROW EXECUTE FUNCTION public.stripe_read_auth_immutable();--> statement-breakpoint
CREATE TRIGGER stripe_read_policy_events_no_update_delete BEFORE UPDATE OR DELETE ON public.stripe_read_policy_events FOR EACH ROW EXECUTE FUNCTION public.stripe_read_auth_immutable();--> statement-breakpoint
CREATE TRIGGER stripe_read_policy_changes_no_truncate BEFORE TRUNCATE ON public.stripe_read_policy_changes FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
CREATE TRIGGER stripe_read_policy_events_no_truncate BEFORE TRUNCATE ON public.stripe_read_policy_events FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_changes ENABLE ALWAYS TRIGGER stripe_read_policy_changes_guard;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_changes ENABLE ALWAYS TRIGGER stripe_read_policy_changes_audit;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_changes ENABLE ALWAYS TRIGGER stripe_read_policy_changes_no_delete;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_changes ENABLE ALWAYS TRIGGER stripe_read_policy_changes_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_events ENABLE ALWAYS TRIGGER stripe_read_policy_events_no_update_delete;--> statement-breakpoint
ALTER TABLE public.stripe_read_policy_events ENABLE ALWAYS TRIGGER stripe_read_policy_events_no_truncate;--> statement-breakpoint
-- Administrator-facing functions. Row locks serialize concurrent decisions; an exact repeat is idempotent and a conflicting decision fails deterministically.
CREATE FUNCTION public.stripe_read_policy_propose(p_actor uuid, p_target boolean, p_expected_version integer, p_justification text, p_expires_ms bigint) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO public.stripe_read_policy_changes (expected_policy_version, target_state, state, version, justification, proposed_by, expires_at_ms)
  VALUES (p_expected_version, p_target, 'PENDING', 1, p_justification, p_actor, p_expires_ms) RETURNING id INTO new_id;
  RETURN new_id;
END $$;--> statement-breakpoint
CREATE FUNCTION public.stripe_read_policy_decide(p_id uuid, p_actor uuid, p_decision text, p_ref text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.stripe_read_policy_changes; target text;
BEGIN
  target := CASE p_decision WHEN 'APPROVE' THEN 'APPROVED' WHEN 'REJECT' THEN 'REJECTED' WHEN 'CANCEL' THEN 'CANCELLED' ELSE NULL END;
  IF target IS NULL THEN RAISE EXCEPTION 'READ_POLICY_INVALID_TRANSITION: unknown decision'; END IF;
  SELECT * INTO r FROM public.stripe_read_policy_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'READ_POLICY_NOT_FOUND: no such policy-change request'; END IF;
  IF r.state <> 'PENDING' THEN
    IF r.state = target AND r.decided_by = p_actor AND r.decision_ref = p_ref THEN RETURN r.version; END IF; -- an exact repeat is idempotent
    RAISE EXCEPTION 'READ_POLICY_DECISION_CONFLICT: the request is already % and cannot take a different decision', r.state;
  END IF;
  UPDATE public.stripe_read_policy_changes SET state = target, version = r.version + 1, decided_by = p_actor, decision_ref = p_ref, decided_at_ms = 0 WHERE id = p_id;
  RETURN r.version + 1;
END $$;--> statement-breakpoint
CREATE FUNCTION public.stripe_read_policy_expire(p_id uuid, p_actor uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.stripe_read_policy_changes;
BEGIN
  SELECT * INTO r FROM public.stripe_read_policy_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'READ_POLICY_NOT_FOUND: no such policy-change request'; END IF;
  IF r.state = 'EXPIRED' THEN RETURN r.version; END IF;
  IF r.state <> 'PENDING' THEN RAISE EXCEPTION 'READ_POLICY_DECISION_CONFLICT: the request is already % and cannot expire', r.state; END IF;
  UPDATE public.stripe_read_policy_changes SET state = 'EXPIRED', version = r.version + 1, decided_by = p_actor, decision_ref = 'EXPIRED', decided_at_ms = 0 WHERE id = p_id;
  RETURN r.version + 1;
END $$;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_policy_row_audit() OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_policy_change_guard() OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_policy_change_audit() OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_policy_propose(uuid, boolean, integer, text, bigint) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_policy_decide(uuid, uuid, text, text) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_policy_expire(uuid, uuid) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stripe_read_policy_row_audit(), public.stripe_read_policy_change_guard(), public.stripe_read_policy_change_audit(), public.stripe_read_policy_row_before() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stripe_read_policy_change_digest(public.stripe_read_policy_changes), public.stripe_read_policy_row_digest(boolean, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stripe_read_policy_propose(uuid, boolean, integer, text, bigint), public.stripe_read_policy_decide(uuid, uuid, text, text), public.stripe_read_policy_expire(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stripe_read_policy_propose(uuid, boolean, integer, text, bigint), public.stripe_read_policy_decide(uuid, uuid, text, text), public.stripe_read_policy_expire(uuid, uuid) TO stripe_read_auth_admin;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stripe_read_policy_change_digest(public.stripe_read_policy_changes), public.stripe_read_policy_row_digest(boolean, integer) TO stripe_read_auth_lifecycle;--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('dev13.schema_create_granted', true) = 'on' THEN REVOKE CREATE ON SCHEMA public FROM stripe_read_auth_lifecycle; END IF;
  IF current_setting('dev13.membership_granted', true) = 'on' THEN REVOKE stripe_read_auth_lifecycle FROM CURRENT_USER; END IF;
  PERFORM set_config('dev13.schema_create_granted', '', false);
  PERFORM set_config('dev13.membership_granted', '', false);
END $$;
