CREATE TABLE "onboarding_erasure_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"request_ref" text NOT NULL,
	"operator_role" text NOT NULL,
	"events_erased" integer NOT NULL,
	"events_deferred" integer NOT NULL,
	"residual_singletons" integer NOT NULL,
	"cashier_severed" boolean NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_erasure_operations_outcome_check" CHECK ("onboarding_erasure_operations"."outcome" IN ('completed','partial','noop')),
	CONSTRAINT "onboarding_erasure_operations_counts_check" CHECK ("onboarding_erasure_operations"."events_erased" >= 0 AND "onboarding_erasure_operations"."events_deferred" >= 0 AND "onboarding_erasure_operations"."residual_singletons" >= 0),
	CONSTRAINT "onboarding_erasure_operations_request_ref_check" CHECK ("onboarding_erasure_operations"."request_ref" ~ '^[A-Za-z0-9._:-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" DROP CONSTRAINT "customer_onboarding_events_cashier_shape_check";--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" DROP CONSTRAINT "customer_onboarding_events_assisted_reference_check";--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ALTER COLUMN "membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD COLUMN "erasure_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "onboarding_erasure_operations" ADD CONSTRAINT "onboarding_erasure_operations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_erasure_operations_business_created_idx" ON "onboarding_erasure_operations" USING btree ("business_id","created_at");--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_erasure_operation_id_onboarding_erasure_operations_id_fk" FOREIGN KEY ("erasure_operation_id") REFERENCES "public"."onboarding_erasure_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_erasure_shape_check" CHECK (("customer_onboarding_events"."erased_at" IS NULL AND "customer_onboarding_events"."erasure_operation_id" IS NULL AND "customer_onboarding_events"."customer_id" IS NOT NULL AND "customer_onboarding_events"."membership_id" IS NOT NULL)
        OR ("customer_onboarding_events"."erased_at" IS NOT NULL AND "customer_onboarding_events"."erasure_operation_id" IS NOT NULL AND "customer_onboarding_events"."customer_id" IS NULL AND "customer_onboarding_events"."membership_id" IS NULL
            AND "customer_onboarding_events"."consent_grant_id" IS NULL AND "customer_onboarding_events"."audit_log_id" IS NULL AND "customer_onboarding_events"."reference" IS NULL));--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_cashier_shape_check" CHECK (("customer_onboarding_events"."erased_at" IS NULL AND ("customer_onboarding_events"."source" = 'cashier_assisted') = ("customer_onboarding_events"."cashier_user_id" IS NOT NULL))
        OR ("customer_onboarding_events"."erased_at" IS NOT NULL AND ("customer_onboarding_events"."source" = 'cashier_assisted' OR "customer_onboarding_events"."cashier_user_id" IS NULL)));--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_assisted_reference_check" CHECK ("customer_onboarding_events"."source" <> 'cashier_assisted' OR "customer_onboarding_events"."reference" IS NOT NULL OR "customer_onboarding_events"."erased_at" IS NOT NULL);--> statement-breakpoint
-- =====================================================================================================================================
-- CASHIER-PROD-D2-R1: controlled anonymization of onboarding events. DEVELOPMENT ONLY; not applied to any shared database.
--
-- Ordinary behaviour is unchanged: customer_onboarding_events stays append-only (UPDATE, DELETE and TRUNCATE are refused; the guard trigger
-- keeps ENABLE ALWAYS). The ONE exception is a single, shape-checked UPDATE that severs the personal links of an event, and it is allowed
-- only when the statement runs as the internal role onboarding_erasure_owner, which owns the SECURITY DEFINER function below and is a member
-- of nobody. No session variable, marker or operation identifier is trusted: the guard checks current_user, which an ordinary session
-- cannot change. A superuser or the migrator could still SET ROLE or drop the trigger: that is database-administrator authority, outside
-- this control, and is why execution is limited to a dedicated operator role that nobody is a member of until the Owner approves a workflow.
--
-- ROLES (NOLOGIN group roles; no login role, password or membership is created here; provisioning is a separate owner decision):
--   onboarding_erasure_owner     internal: owns the function; may UPDATE only the severable columns of the events table and INSERT the audit row
--   onboarding_erasure_operator  may EXECUTE the erasure function and read its audit table; nothing else
-- =====================================================================================================================================
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['onboarding_erasure_owner','onboarding_erasure_operator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole)) THEN
      RAISE EXCEPTION 'D2R1: role % exists with unsafe attributes (superuser, BYPASSRLS, LOGIN or CREATEROLE); refusing to continue', r;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- Same temporary membership/schema grants as migrations 0061 and 0062, for a migrator that is not a superuser; removed again at the end of this file.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT pg_has_role(current_user, 'onboarding_erasure_owner', 'SET') THEN
      GRANT onboarding_erasure_owner TO CURRENT_USER;
      PERFORM set_config('d2r1.membership_granted', 'on', false);
    END IF;
    IF NOT has_schema_privilege('onboarding_erasure_owner', 'public', 'CREATE') THEN
      GRANT CREATE ON SCHEMA public TO onboarding_erasure_owner;
      PERFORM set_config('d2r1.schema_create_granted', 'on', false);
    END IF;
  END IF;
END $$;--> statement-breakpoint
-- The erasure audit table is append-only, tenant-scoped by a nullable business id, and holds no personal data.
REVOKE ALL ON TABLE public.onboarding_erasure_operations FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.onboarding_erasure_operations TO onboarding_erasure_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.onboarding_erasure_operations TO onboarding_erasure_operator;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.onboarding_erasure_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ONBOARDING_ERASURE_AUDIT_APPEND_ONLY (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;--> statement-breakpoint
CREATE TRIGGER onboarding_erasure_operation_guard_trg BEFORE UPDATE OR DELETE ON public.onboarding_erasure_operations
  FOR EACH ROW EXECUTE FUNCTION public.onboarding_erasure_operation_guard();--> statement-breakpoint
CREATE TRIGGER onboarding_erasure_operations_no_truncate BEFORE TRUNCATE ON public.onboarding_erasure_operations
  FOR EACH STATEMENT EXECUTE FUNCTION public.onboarding_erasure_operation_guard();--> statement-breakpoint
ALTER TABLE public.onboarding_erasure_operations ENABLE ALWAYS TRIGGER onboarding_erasure_operation_guard_trg;--> statement-breakpoint
ALTER TABLE public.onboarding_erasure_operations ENABLE ALWAYS TRIGGER onboarding_erasure_operations_no_truncate;--> statement-breakpoint
-- The events guard, replaced IN PLACE (the trigger itself and its ENABLE ALWAYS setting are untouched). Everything 0083 enforced on INSERT is
-- kept verbatim; an INSERT can no longer carry erasure state. UPDATE is refused unless it is the one approved transition run by the erasure role.
CREATE OR REPLACE FUNCTION customer_onboarding_event_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  membership_row business_customer_memberships%ROWTYPE;
  branch_business uuid;
  grant_row consent_grants%ROWTYPE;
  audit_business uuid;
  audit_found boolean;
  cashier_row users%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ONBOARDING_EVENT_APPEND_ONLY (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The only permitted UPDATE: the erasure function, as its owner role, severing the personal links of a not-yet-erased event.
    IF current_user <> 'onboarding_erasure_owner' THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_APPEND_ONLY (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.erased_at IS NOT NULL OR NEW.erased_at IS NULL OR NEW.erasure_operation_id IS NULL
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.source IS DISTINCT FROM OLD.source OR NEW.verification_state IS DISTINCT FROM OLD.verification_state
       OR NEW.is_rejoin IS DISTINCT FROM OLD.is_rejoin
       OR NEW.customer_id IS NOT NULL OR NEW.membership_id IS NOT NULL OR NEW.consent_grant_id IS NOT NULL
       OR NEW.audit_log_id IS NOT NULL OR NEW.reference IS NOT NULL
       OR (NEW.cashier_user_id IS NOT NULL AND NEW.cashier_user_id IS DISTINCT FROM OLD.cashier_user_id)
       OR NEW.occurred_at IS DISTINCT FROM (date_trunc('day', OLD.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
       OR NEW.recorded_at IS DISTINCT FROM (date_trunc('day', OLD.recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
       OR NOT EXISTS (SELECT 1 FROM public.onboarding_erasure_operations o WHERE o.id = NEW.erasure_operation_id AND o.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_ERASURE_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.erased_at IS NOT NULL OR NEW.erasure_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'ONBOARDING_EVENT_ERASED_STATE_NOT_INSERTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO membership_row FROM business_customer_memberships WHERE id = NEW.membership_id;
  IF NOT FOUND OR membership_row.business_id <> NEW.business_id OR membership_row.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'ONBOARDING_EVENT_MEMBERSHIP_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.branch_id IS NOT NULL THEN
    SELECT business_id INTO branch_business FROM branches WHERE id = NEW.branch_id;
    IF branch_business IS NULL OR branch_business <> NEW.business_id THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_BRANCH_NOT_IN_BUSINESS' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.consent_grant_id IS NOT NULL THEN
    SELECT * INTO grant_row FROM consent_grants WHERE id = NEW.consent_grant_id;
    IF NOT FOUND OR grant_row.customer_id <> NEW.customer_id OR grant_row.business_id <> NEW.business_id
       OR grant_row.purpose <> 'join_loyalty' THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_CONSENT_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.audit_log_id IS NOT NULL THEN
    SELECT business_id, true INTO audit_business, audit_found FROM audit_log WHERE id = NEW.audit_log_id;
    IF audit_found IS NOT TRUE OR audit_business IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_AUDIT_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.cashier_user_id IS NOT NULL THEN
    SELECT * INTO cashier_row FROM users WHERE id = NEW.cashier_user_id;
    IF NOT FOUND OR cashier_row.status <> 'active'
       OR (cashier_row.managed_business_id IS NOT NULL AND cashier_row.managed_business_id <> NEW.business_id) THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_CASHIER_NOT_ELIGIBLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM user_business_roles ubr
      WHERE ubr.user_id = NEW.cashier_user_id AND ubr.business_id = NEW.business_id AND ubr.deleted_at IS NULL
        AND (ubr.branch_id IS NULL OR ubr.branch_id = NEW.branch_id)
    ) THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_CASHIER_NOT_AUTHORIZED_FOR_BRANCH' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
-- The erasure role may read the events and change ONLY the severable columns (column-level privilege); the guard narrows that further to one transition.
GRANT SELECT ON TABLE public.customer_onboarding_events TO onboarding_erasure_owner;--> statement-breakpoint
GRANT UPDATE (customer_id, membership_id, consent_grant_id, audit_log_id, reference, cashier_user_id, occurred_at, recorded_at, erased_at, erasure_operation_id)
  ON TABLE public.customer_onboarding_events TO onboarding_erasure_owner;--> statement-breakpoint
-- THE FUNCTION. Scope is fixed by its arguments (one business, one customer): there is no arbitrary table, tenant or predicate, and no dynamic SQL.
-- It takes the same advisory lock as join, leave and consent withdrawal (membership-lifecycle.ts), so it cannot interleave with them; it locks
-- the candidate rows, writes the minimal audit row, then performs the guarded UPDATE, and any failure rolls everything back.
-- An assisted-invitation event younger than 15 minutes is DEFERRED (left untouched): an invitation lives 10 minutes, and severing the
-- invitation id before it expires would let the single-use check be bypassed. Re-running the function later erases it.
CREATE OR REPLACE FUNCTION public.onboarding_erase_customer_events(p_business_id uuid, p_customer_id uuid, p_request_ref text, p_sever_cashier boolean DEFAULT false)
RETURNS TABLE (out_operation_id uuid, out_events_erased integer, out_events_deferred integer, out_residual_singletons integer, out_outcome text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_op uuid := gen_random_uuid();
  v_ids uuid[];
  v_erased integer;
  v_deferred integer;
  v_single integer;
  v_outcome text;
  v_updated integer;
  v_cutoff timestamptz := now() - interval '15 minutes';
BEGIN
  IF p_business_id IS NULL OR p_customer_id IS NULL OR p_sever_cashier IS NULL THEN
    RAISE EXCEPTION 'ONBOARDING_ERASURE_SCOPE_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_request_ref IS NULL OR p_request_ref !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
    RAISE EXCEPTION 'ONBOARDING_ERASURE_REQUEST_REF_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('customer_business_relationship:' || p_customer_id::text || ':' || p_business_id::text, 0));
  SELECT array_agg(s.id) INTO v_ids FROM (
    SELECT e.id FROM public.customer_onboarding_events e
    WHERE e.business_id = p_business_id AND e.customer_id = p_customer_id AND e.erased_at IS NULL
      AND (e.source <> 'cashier_assisted' OR e.occurred_at <= v_cutoff)
    ORDER BY e.id FOR UPDATE) s;
  v_erased := COALESCE(cardinality(v_ids), 0);
  SELECT count(*)::integer INTO v_deferred FROM public.customer_onboarding_events e
    WHERE e.business_id = p_business_id AND e.customer_id = p_customer_id AND e.erased_at IS NULL AND NOT (e.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[])));
  -- Residual re-identification signal: erased events whose remaining attributes (branch, source, cashier if kept, day, verification, re-join) are unique.
  SELECT count(*)::integer INTO v_single FROM (
    SELECT c.k FROM (
      SELECT row(e.business_id, e.branch_id, e.source, CASE WHEN p_sever_cashier THEN NULL ELSE e.cashier_user_id END,
                 date_trunc('day', e.occurred_at AT TIME ZONE 'UTC'), e.verification_state, e.is_rejoin)::text AS k
      FROM public.customer_onboarding_events e WHERE e.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
    ) c
    GROUP BY c.k
    HAVING count(*) + (
      SELECT count(*) FROM public.customer_onboarding_events x
      WHERE x.business_id = p_business_id AND x.erased_at IS NOT NULL
        AND row(x.business_id, x.branch_id, x.source, x.cashier_user_id, date_trunc('day', x.occurred_at AT TIME ZONE 'UTC'), x.verification_state, x.is_rejoin)::text = c.k
    ) = 1
  ) u;
  v_outcome := CASE WHEN v_erased = 0 AND v_deferred = 0 THEN 'noop' WHEN v_deferred > 0 THEN 'partial' ELSE 'completed' END;
  INSERT INTO public.onboarding_erasure_operations (id, business_id, request_ref, operator_role, events_erased, events_deferred, residual_singletons, cashier_severed, outcome)
    VALUES (v_op, p_business_id, p_request_ref, session_user::text, v_erased, v_deferred, v_single, p_sever_cashier, v_outcome);
  IF v_erased > 0 THEN
    UPDATE public.customer_onboarding_events e SET
      customer_id = NULL, membership_id = NULL, consent_grant_id = NULL, audit_log_id = NULL, reference = NULL,
      cashier_user_id = CASE WHEN p_sever_cashier THEN NULL ELSE e.cashier_user_id END,
      occurred_at = (date_trunc('day', e.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
      recorded_at = (date_trunc('day', e.recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
      erased_at = now(), erasure_operation_id = v_op
    WHERE e.id = ANY (v_ids);
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> v_erased THEN
      RAISE EXCEPTION 'ONBOARDING_ERASURE_COUNT_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN QUERY SELECT v_op, v_erased, v_deferred, v_single, v_outcome;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.onboarding_erase_customer_events(uuid, uuid, text, boolean) FROM PUBLIC;--> statement-breakpoint
ALTER FUNCTION public.onboarding_erase_customer_events(uuid, uuid, text, boolean) OWNER TO onboarding_erasure_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.onboarding_erase_customer_events(uuid, uuid, text, boolean) TO onboarding_erasure_operator;--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('d2r1.schema_create_granted', true) = 'on' THEN REVOKE CREATE ON SCHEMA public FROM onboarding_erasure_owner; END IF;
  IF current_setting('d2r1.membership_granted', true) = 'on' THEN REVOKE onboarding_erasure_owner FROM CURRENT_USER; END IF;
  PERFORM set_config('d2r1.schema_create_granted', '', false);
  PERFORM set_config('d2r1.membership_granted', '', false);
END $$;
