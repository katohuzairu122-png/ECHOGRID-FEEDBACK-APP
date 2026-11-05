CREATE TABLE "stripe_read_authorization_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"event_type" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"evidence_ref" text,
	"at_ms" bigint NOT NULL,
	"record_digest" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "stripe_read_auth_events_version_key" UNIQUE("authorization_id","version"),
	CONSTRAINT "stripe_read_auth_events_type_check" CHECK ("stripe_read_authorization_events"."event_type" IN ('PROPOSED','APPROVED','REVOKED') AND "stripe_read_authorization_events"."to_state" IN ('PENDING','APPROVED','REVOKED') AND ("stripe_read_authorization_events"."from_state" IS NULL OR "stripe_read_authorization_events"."from_state" IN ('PENDING','APPROVED','REVOKED'))),
	CONSTRAINT "stripe_read_auth_events_digest_check" CHECK ("stripe_read_authorization_events"."record_digest" ~ '^[0-9a-f]{64}$' AND "stripe_read_authorization_events"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "stripe_read_authorization_policy" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"approval_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "stripe_read_auth_policy_singleton_check" CHECK ("stripe_read_authorization_policy"."singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "stripe_read_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"realm" text NOT NULL,
	"workload_id" text NOT NULL,
	"method_id" text NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"valid_from_ms" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"inventory_record_id" text NOT NULL,
	"inventory_revision" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at_ms" bigint,
	"approval_evidence_ref" text,
	"revoked_by" uuid,
	"revoked_at_ms" bigint,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "stripe_read_auth_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "stripe_read_auth_realm_check" CHECK ("stripe_read_authorizations"."realm" = 'test'),
	CONSTRAINT "stripe_read_auth_method_check" CHECK ("stripe_read_authorizations"."method_id" IN ('ACCOUNT_RETRIEVE_CURRENT','INVOICE_RETRIEVE','INVOICE_LINES_LIST','PAYMENT_RETRIEVE','REFUNDS_LIST','DISPUTES_LIST')),
	CONSTRAINT "stripe_read_auth_state_check" CHECK ("stripe_read_authorizations"."state" IN ('PENDING','APPROVED','REVOKED')),
	CONSTRAINT "stripe_read_auth_refs_check" CHECK ("stripe_read_authorizations"."account_id" ~ '^acct_[A-Za-z0-9]{1,128}$' AND "stripe_read_authorizations"."workload_id" ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$' AND "stripe_read_authorizations"."inventory_record_id" ~ '^[!-~]{1,255}$' AND "stripe_read_authorizations"."inventory_revision" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "stripe_read_auth_window_check" CHECK ("stripe_read_authorizations"."valid_from_ms" >= 0 AND "stripe_read_authorizations"."expires_at_ms" > "stripe_read_authorizations"."valid_from_ms"),
	CONSTRAINT "stripe_read_auth_version_check" CHECK ("stripe_read_authorizations"."version" >= 1),
	CONSTRAINT "stripe_read_auth_state_fields_check" CHECK (("stripe_read_authorizations"."state" = 'PENDING' AND "stripe_read_authorizations"."approved_by" IS NULL AND "stripe_read_authorizations"."approved_at_ms" IS NULL AND "stripe_read_authorizations"."approval_evidence_ref" IS NULL AND "stripe_read_authorizations"."revoked_by" IS NULL AND "stripe_read_authorizations"."revoked_at_ms" IS NULL AND "stripe_read_authorizations"."revoke_reason" IS NULL)
    OR ("stripe_read_authorizations"."state" = 'APPROVED' AND "stripe_read_authorizations"."approved_by" IS NOT NULL AND "stripe_read_authorizations"."approved_at_ms" IS NOT NULL AND "stripe_read_authorizations"."approval_evidence_ref" IS NOT NULL AND "stripe_read_authorizations"."approval_evidence_ref" ~ '^[!-~]{1,255}$' AND "stripe_read_authorizations"."revoked_by" IS NULL AND "stripe_read_authorizations"."revoked_at_ms" IS NULL AND "stripe_read_authorizations"."revoke_reason" IS NULL)
    OR ("stripe_read_authorizations"."state" = 'REVOKED' AND "stripe_read_authorizations"."revoked_by" IS NOT NULL AND "stripe_read_authorizations"."revoked_at_ms" IS NOT NULL AND "stripe_read_authorizations"."revoke_reason" IS NOT NULL AND "stripe_read_authorizations"."revoke_reason" ~ '^[A-Z_]{1,64}$' AND ("stripe_read_authorizations"."approved_by" IS NULL) = ("stripe_read_authorizations"."approved_at_ms" IS NULL) AND ("stripe_read_authorizations"."approved_by" IS NULL) = ("stripe_read_authorizations"."approval_evidence_ref" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "stripe_read_authorization_events" ADD CONSTRAINT "stripe_read_authorization_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_authorization_events" ADD CONSTRAINT "stripe_read_auth_events_auth_fk" FOREIGN KEY ("authorization_id","business_id") REFERENCES "public"."stripe_read_authorizations"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_authorizations" ADD CONSTRAINT "stripe_read_authorizations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_authorizations" ADD CONSTRAINT "stripe_read_authorizations_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_authorizations" ADD CONSTRAINT "stripe_read_authorizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_read_authorizations" ADD CONSTRAINT "stripe_read_authorizations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_read_auth_live_key" ON "stripe_read_authorizations" USING btree ("business_id","account_id","workload_id","method_id") WHERE "stripe_read_authorizations"."state" IN ('PENDING','APPROVED');--> statement-breakpoint
CREATE INDEX "stripe_read_auth_lookup_idx" ON "stripe_read_authorizations" USING btree ("business_id","method_id");--> statement-breakpoint

-- S08-D1D3-DEV-10 (durable Stripe read authorization). ADDITIVE, INERT, development only. The generated DDL above creates the tables; everything below is the authority around them.
-- Nothing here activates a Stripe read, grants a method, creates a login role or a credential. The approval write path is DISABLED by default (stripe_read_authorization_policy).
-- Migrations 0053-0061 and their financial guards are untouched.
INSERT INTO public.stripe_read_authorization_policy (singleton, approval_enabled) VALUES (true, false);--> statement-breakpoint
-- ROLES (NOLOGIN group roles; no login role, password or membership is created here; production provisioning is a separate owner decision).
--   stripe_read_auth_lifecycle     internal: owns the SECURITY DEFINER lifecycle/lookup/trigger functions and is the only role that may write the tables; nobody should be made a member
--   stripe_read_auth_admin         may EXECUTE propose / approve / revoke (the application layer is responsible for authenticating the platform administrator it passes)
--   stripe_read_auth_verifier      the trusted verifier workload: may EXECUTE the lookup function only; no table privilege
--   stripe_read_auth_tenant_reader read-only on the authorization tables, restricted by RLS to the tenant in the session setting echogrid.tenant_id (a READ scope only)
--   stripe_read_auth_auditor       read-only on every row
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['stripe_read_auth_lifecycle','stripe_read_auth_admin','stripe_read_auth_verifier','stripe_read_auth_tenant_reader','stripe_read_auth_auditor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole)) THEN
      RAISE EXCEPTION 'DEV10: role % exists with unsafe attributes (superuser, BYPASSRLS, LOGIN or CREATEROLE); refusing to continue', r;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- Same temporary membership/schema grants as migration 0061, for a migrator that is not a superuser; removed again at the end of this file.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT pg_has_role(current_user, 'stripe_read_auth_lifecycle', 'SET') THEN
      GRANT stripe_read_auth_lifecycle TO CURRENT_USER;
      PERFORM set_config('dev10.membership_granted', 'on', false);
    END IF;
    IF NOT has_schema_privilege('stripe_read_auth_lifecycle', 'public', 'CREATE') THEN
      GRANT CREATE ON SCHEMA public TO stripe_read_auth_lifecycle;
      PERFORM set_config('dev10.schema_create_granted', 'on', false);
    END IF;
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON TABLE public.stripe_read_authorizations, public.stripe_read_authorization_events, public.stripe_read_authorization_policy FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.stripe_read_authorizations TO stripe_read_auth_lifecycle;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.stripe_read_authorization_events TO stripe_read_auth_lifecycle;--> statement-breakpoint
GRANT SELECT ON TABLE public.stripe_read_authorization_policy TO stripe_read_auth_lifecycle, stripe_read_auth_auditor;--> statement-breakpoint
GRANT SELECT ON TABLE public.stripe_read_authorizations, public.stripe_read_authorization_events TO stripe_read_auth_auditor, stripe_read_auth_tenant_reader;--> statement-breakpoint
-- The lifecycle role needs to see only who an administrator is; column-level, nothing else of the user is readable.
GRANT SELECT (id, status, platform_role, deleted_at) ON TABLE public.users TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorizations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_policy FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY read_auth_lifecycle_select ON public.stripe_read_authorizations FOR SELECT TO stripe_read_auth_lifecycle USING (true);--> statement-breakpoint
CREATE POLICY read_auth_lifecycle_insert ON public.stripe_read_authorizations FOR INSERT TO stripe_read_auth_lifecycle WITH CHECK (true);--> statement-breakpoint
CREATE POLICY read_auth_lifecycle_update ON public.stripe_read_authorizations FOR UPDATE TO stripe_read_auth_lifecycle USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY read_auth_auditor_select ON public.stripe_read_authorizations FOR SELECT TO stripe_read_auth_auditor USING (true);--> statement-breakpoint
CREATE POLICY read_auth_tenant_select ON public.stripe_read_authorizations FOR SELECT TO stripe_read_auth_tenant_reader USING (business_id::text = current_setting('echogrid.tenant_id', true));--> statement-breakpoint
CREATE POLICY read_auth_events_lifecycle_select ON public.stripe_read_authorization_events FOR SELECT TO stripe_read_auth_lifecycle USING (true);--> statement-breakpoint
CREATE POLICY read_auth_events_lifecycle_insert ON public.stripe_read_authorization_events FOR INSERT TO stripe_read_auth_lifecycle WITH CHECK (true);--> statement-breakpoint
CREATE POLICY read_auth_events_auditor_select ON public.stripe_read_authorization_events FOR SELECT TO stripe_read_auth_auditor USING (true);--> statement-breakpoint
CREATE POLICY read_auth_events_tenant_select ON public.stripe_read_authorization_events FOR SELECT TO stripe_read_auth_tenant_reader USING (business_id::text = current_setting('echogrid.tenant_id', true));--> statement-breakpoint
CREATE POLICY read_auth_policy_lifecycle_select ON public.stripe_read_authorization_policy FOR SELECT TO stripe_read_auth_lifecycle USING (true);--> statement-breakpoint
CREATE POLICY read_auth_policy_auditor_select ON public.stripe_read_authorization_policy FOR SELECT TO stripe_read_auth_auditor USING (true);--> statement-breakpoint
-- Server-side clock: lifecycle timestamps are never supplied by a caller.
CREATE FUNCTION public.stripe_read_auth_now_ms() RETURNS bigint LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$ SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint $$;--> statement-breakpoint
-- Canonical digest of one authorization row (length-prefixed, versioned); the audit trail records it so a later change to the row is visible against the trail.
CREATE FUNCTION public.stripe_read_auth_record_digest(r public.stripe_read_authorizations) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to((SELECT string_agg(char_length(v) || ':' || v || ';', '' ORDER BY n) FROM unnest(ARRAY[
    'ECHO-GRID:S08-READ-AUTH/1', r.id::text, r.business_id::text, r.account_id, r.realm, r.workload_id, r.method_id, r.state, r.version::text, r.valid_from_ms::text, r.expires_at_ms::text,
    r.inventory_record_id, r.inventory_revision, r.proposed_by::text, coalesce(r.approved_by::text, ''), coalesce(r.approved_at_ms::text, ''), coalesce(r.approval_evidence_ref, ''),
    coalesce(r.revoked_by::text, ''), coalesce(r.revoked_at_ms::text, ''), coalesce(r.revoke_reason, '')]) WITH ORDINALITY AS t(v, n)), 'UTF8')), 'hex')
$$;--> statement-breakpoint
CREATE FUNCTION public.stripe_read_auth_is_admin(p_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.platform_role = 'admin' AND u.deleted_at IS NULL)
$$;--> statement-breakpoint
-- THE GUARD. Runs on every INSERT and UPDATE whoever the caller is, so the lifecycle cannot be skipped by writing the table directly. It fixes timestamps to the server clock and
-- rejects: a non-PENDING insert, a non-administrator proposer / approver / revoker, self-approval, approval while the switch is off, approval of an expired authorization, any change to
-- an identity column, any change out of REVOKED (terminal), a replayed or skipped version, and every transition that is not PENDING->APPROVED, PENDING->REVOKED or APPROVED->REVOKED.
CREATE FUNCTION public.stripe_read_auth_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE now_ms bigint := public.stripe_read_auth_now_ms(); enabled boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' OR NEW.version <> 1 THEN RAISE EXCEPTION 'READ_AUTH_INSERT_NOT_PENDING: an authorization is created PENDING at version 1'; END IF;
    IF NOT public.stripe_read_auth_is_admin(NEW.proposed_by) THEN RAISE EXCEPTION 'READ_AUTH_ADMIN_REQUIRED: the proposer must be an active platform administrator'; END IF;
    IF NEW.expires_at_ms <= now_ms THEN RAISE EXCEPTION 'READ_AUTH_EXPIRED: an authorization cannot be created already expired'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR NEW.account_id <> OLD.account_id OR NEW.realm <> OLD.realm OR NEW.workload_id <> OLD.workload_id OR NEW.method_id <> OLD.method_id
     OR NEW.valid_from_ms <> OLD.valid_from_ms OR NEW.expires_at_ms <> OLD.expires_at_ms OR NEW.inventory_record_id <> OLD.inventory_record_id OR NEW.inventory_revision <> OLD.inventory_revision
     OR NEW.proposed_by <> OLD.proposed_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'READ_AUTH_IMMUTABLE: the identity of an authorization is never changed; a different grant is a new authorization';
  END IF;
  IF OLD.state = 'REVOKED' THEN RAISE EXCEPTION 'READ_AUTH_REVOKED_TERMINAL: a revoked authorization is never reactivated or changed'; END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'READ_AUTH_VERSION: the version must advance by exactly one'; END IF;
  IF OLD.state = 'PENDING' AND NEW.state = 'APPROVED' THEN
    SELECT p.approval_enabled INTO enabled FROM public.stripe_read_authorization_policy p WHERE p.singleton;
    IF enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'READ_AUTH_APPROVAL_DISABLED: the approval write path is disabled pending the owner''s approval policy'; END IF;
    IF NEW.approved_by IS NULL OR NOT public.stripe_read_auth_is_admin(NEW.approved_by) THEN RAISE EXCEPTION 'READ_AUTH_ADMIN_REQUIRED: the approver must be an active platform administrator'; END IF;
    IF NEW.approved_by = OLD.proposed_by THEN RAISE EXCEPTION 'READ_AUTH_SELF_APPROVAL: the proposer cannot approve their own authorization'; END IF;
    IF now_ms >= OLD.expires_at_ms THEN RAISE EXCEPTION 'READ_AUTH_EXPIRED: an expired authorization cannot be approved or renewed implicitly'; END IF;
    NEW.approved_at_ms := now_ms; NEW.revoked_by := NULL; NEW.revoked_at_ms := NULL; NEW.revoke_reason := NULL;
    RETURN NEW;
  END IF;
  IF NEW.state = 'REVOKED' AND OLD.state IN ('PENDING','APPROVED') THEN
    IF NEW.revoked_by IS NULL OR NOT public.stripe_read_auth_is_admin(NEW.revoked_by) THEN RAISE EXCEPTION 'READ_AUTH_ADMIN_REQUIRED: the revoker must be an active platform administrator'; END IF;
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at_ms IS DISTINCT FROM OLD.approved_at_ms OR NEW.approval_evidence_ref IS DISTINCT FROM OLD.approval_evidence_ref THEN
      RAISE EXCEPTION 'READ_AUTH_IMMUTABLE: approval evidence is never rewritten by a revocation';
    END IF;
    NEW.revoked_at_ms := now_ms;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'READ_AUTH_INVALID_TRANSITION: % -> % is not a permitted transition', OLD.state, NEW.state;
END $$;--> statement-breakpoint
CREATE TRIGGER stripe_read_authorizations_guard BEFORE INSERT OR UPDATE ON public.stripe_read_authorizations FOR EACH ROW EXECUTE FUNCTION public.stripe_read_auth_guard();--> statement-breakpoint
-- The audit event is written by the database for EVERY change, with the digest of the row as changed.
CREATE FUNCTION public.stripe_read_auth_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.stripe_read_authorization_events (authorization_id, business_id, version, event_type, from_state, to_state, actor_id, evidence_ref, at_ms, record_digest)
    VALUES (NEW.id, NEW.business_id, NEW.version, 'PROPOSED', NULL, NEW.state, NEW.proposed_by, NULL, public.stripe_read_auth_now_ms(), public.stripe_read_auth_record_digest(NEW));
  ELSIF NEW.state = 'APPROVED' THEN
    INSERT INTO public.stripe_read_authorization_events (authorization_id, business_id, version, event_type, from_state, to_state, actor_id, evidence_ref, at_ms, record_digest)
    VALUES (NEW.id, NEW.business_id, NEW.version, 'APPROVED', OLD.state, NEW.state, NEW.approved_by, NEW.approval_evidence_ref, NEW.approved_at_ms, public.stripe_read_auth_record_digest(NEW));
  ELSIF NEW.state = 'REVOKED' THEN
    INSERT INTO public.stripe_read_authorization_events (authorization_id, business_id, version, event_type, from_state, to_state, actor_id, evidence_ref, at_ms, record_digest)
    VALUES (NEW.id, NEW.business_id, NEW.version, 'REVOKED', OLD.state, NEW.state, NEW.revoked_by, NEW.revoke_reason, NEW.revoked_at_ms, public.stripe_read_auth_record_digest(NEW));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER stripe_read_authorizations_audit AFTER INSERT OR UPDATE ON public.stripe_read_authorizations FOR EACH ROW EXECUTE FUNCTION public.stripe_read_auth_audit();--> statement-breakpoint
CREATE FUNCTION public.stripe_read_auth_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'READ_AUTH_APPEND_ONLY: read authorization rows and events are never deleted, and audit events are never updated';
END $$;--> statement-breakpoint
CREATE TRIGGER stripe_read_authorizations_no_delete BEFORE DELETE ON public.stripe_read_authorizations FOR EACH ROW EXECUTE FUNCTION public.stripe_read_auth_immutable();--> statement-breakpoint
CREATE TRIGGER stripe_read_authorization_events_no_update_delete BEFORE UPDATE OR DELETE ON public.stripe_read_authorization_events FOR EACH ROW EXECUTE FUNCTION public.stripe_read_auth_immutable();--> statement-breakpoint
CREATE TRIGGER stripe_read_authorization_policy_no_delete BEFORE DELETE ON public.stripe_read_authorization_policy FOR EACH ROW EXECUTE FUNCTION public.stripe_read_auth_immutable();--> statement-breakpoint
CREATE TRIGGER stripe_read_authorizations_no_truncate BEFORE TRUNCATE ON public.stripe_read_authorizations FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
CREATE TRIGGER stripe_read_authorization_events_no_truncate BEFORE TRUNCATE ON public.stripe_read_authorization_events FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
CREATE TRIGGER stripe_read_authorization_policy_no_truncate BEFORE TRUNCATE ON public.stripe_read_authorization_policy FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
-- ENABLE ALWAYS: a session that sets session_replication_role = replica does not skip them.
ALTER TABLE public.stripe_read_authorizations ENABLE ALWAYS TRIGGER stripe_read_authorizations_guard;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorizations ENABLE ALWAYS TRIGGER stripe_read_authorizations_audit;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorizations ENABLE ALWAYS TRIGGER stripe_read_authorizations_no_delete;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorizations ENABLE ALWAYS TRIGGER stripe_read_authorizations_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_events ENABLE ALWAYS TRIGGER stripe_read_authorization_events_no_update_delete;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_events ENABLE ALWAYS TRIGGER stripe_read_authorization_events_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_policy ENABLE ALWAYS TRIGGER stripe_read_authorization_policy_no_delete;--> statement-breakpoint
ALTER TABLE public.stripe_read_authorization_policy ENABLE ALWAYS TRIGGER stripe_read_authorization_policy_no_truncate;--> statement-breakpoint
-- LIFECYCLE FUNCTIONS. Each takes a row lock first, so concurrent approve / revoke calls serialize: the loser sees the committed state and is idempotent or refused, never silent.
CREATE FUNCTION public.stripe_read_auth_propose(p_business uuid, p_account text, p_workload text, p_method text, p_valid_from bigint, p_expires bigint, p_actor uuid, p_inventory_record text, p_inventory_revision text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO public.stripe_read_authorizations (business_id, account_id, realm, workload_id, method_id, state, version, valid_from_ms, expires_at_ms, inventory_record_id, inventory_revision, proposed_by)
  VALUES (p_business, p_account, 'test', p_workload, p_method, 'PENDING', 1, p_valid_from, p_expires, p_inventory_record, p_inventory_revision, p_actor) RETURNING id INTO new_id;
  RETURN new_id;
END $$;--> statement-breakpoint
CREATE FUNCTION public.stripe_read_auth_approve(p_id uuid, p_actor uuid, p_evidence text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.stripe_read_authorizations;
BEGIN
  SELECT * INTO r FROM public.stripe_read_authorizations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'READ_AUTH_NOT_FOUND: no such authorization'; END IF;
  IF r.state = 'APPROVED' THEN
    IF r.approved_by = p_actor AND r.approval_evidence_ref = p_evidence THEN RETURN r.version; END IF; -- an exact repeat is idempotent
    RAISE EXCEPTION 'READ_AUTH_ALREADY_APPROVED: the authorization is already approved with different approval evidence';
  END IF;
  UPDATE public.stripe_read_authorizations SET state = 'APPROVED', version = r.version + 1, approved_by = p_actor, approval_evidence_ref = p_evidence, approved_at_ms = 0 WHERE id = p_id;
  RETURN r.version + 1;
END $$;--> statement-breakpoint
CREATE FUNCTION public.stripe_read_auth_revoke(p_id uuid, p_actor uuid, p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.stripe_read_authorizations;
BEGIN
  SELECT * INTO r FROM public.stripe_read_authorizations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'READ_AUTH_NOT_FOUND: no such authorization'; END IF;
  IF r.state = 'REVOKED' THEN RETURN r.version; END IF; -- already durable
  UPDATE public.stripe_read_authorizations SET state = 'REVOKED', version = r.version + 1, revoked_by = p_actor, revoke_reason = p_reason, revoked_at_ms = 0 WHERE id = p_id;
  RETURN r.version + 1;
END $$;--> statement-breakpoint
-- The verifier's read. Explicit tenant and method arguments; returns only the columns the enforcement code evaluates, newest version first.
CREATE FUNCTION public.stripe_read_auth_lookup(p_business uuid, p_method text)
RETURNS TABLE (authorization_id uuid, business_id uuid, account_id text, realm text, workload_id text, method_id text, state text, version integer, approved_by uuid, valid_from_ms bigint, expires_at_ms bigint, revoked_at_ms bigint, inventory_record_id text, inventory_revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.business_id, a.account_id, a.realm, a.workload_id, a.method_id, a.state, a.version, a.approved_by, a.valid_from_ms, a.expires_at_ms, a.revoked_at_ms, a.inventory_record_id, a.inventory_revision
    FROM public.stripe_read_authorizations a WHERE a.business_id = p_business AND a.method_id = p_method ORDER BY a.created_at DESC, a.id DESC LIMIT 200
$$;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_auth_guard() OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_auth_audit() OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_auth_is_admin(uuid) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_auth_propose(uuid, text, text, text, bigint, bigint, uuid, text, text) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_auth_approve(uuid, uuid, text) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_auth_revoke(uuid, uuid, text) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
ALTER FUNCTION public.stripe_read_auth_lookup(uuid, text) OWNER TO stripe_read_auth_lifecycle;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stripe_read_auth_guard(), public.stripe_read_auth_audit(), public.stripe_read_auth_is_admin(uuid), public.stripe_read_auth_now_ms(), public.stripe_read_auth_immutable() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stripe_read_auth_record_digest(public.stripe_read_authorizations) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stripe_read_auth_propose(uuid, text, text, text, bigint, bigint, uuid, text, text), public.stripe_read_auth_approve(uuid, uuid, text), public.stripe_read_auth_revoke(uuid, uuid, text), public.stripe_read_auth_lookup(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stripe_read_auth_propose(uuid, text, text, text, bigint, bigint, uuid, text, text), public.stripe_read_auth_approve(uuid, uuid, text), public.stripe_read_auth_revoke(uuid, uuid, text) TO stripe_read_auth_admin;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stripe_read_auth_lookup(uuid, text) TO stripe_read_auth_verifier;--> statement-breakpoint
-- The trigger functions run as the lifecycle role: they call now_ms, record_digest and is_admin, which only that role (the owner) and the table owner may execute.
GRANT EXECUTE ON FUNCTION public.stripe_read_auth_now_ms(), public.stripe_read_auth_record_digest(public.stripe_read_authorizations) TO stripe_read_auth_lifecycle;--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('dev10.schema_create_granted', true) = 'on' THEN REVOKE CREATE ON SCHEMA public FROM stripe_read_auth_lifecycle; END IF;
  IF current_setting('dev10.membership_granted', true) = 'on' THEN REVOKE stripe_read_auth_lifecycle FROM CURRENT_USER; END IF;
  PERFORM set_config('dev10.schema_create_granted', '', false);
  PERFORM set_config('dev10.membership_granted', '', false);
END $$;
