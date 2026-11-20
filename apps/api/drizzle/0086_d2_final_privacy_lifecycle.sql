-- =====================================================================================================================================
-- D2-FINAL (CASHIER-PROD / privacy lifecycle): the safe technical foundation for verified customer privacy requests, customer shell
-- anonymization, legal holds and a retention registry. NOT APPLIED TO ANY SHARED DATABASE. Nothing here is a legal or retention approval.
--
-- DESIGN (why anonymize a shell instead of deleting a customer):
--   customers is referenced by 26 tables; some CASCADE (sessions, credentials, memberships, loyalty accounts) and some are RESTRICT
--   (community points, purchase events, orphan settlements, sanctions, surveys, onboarding events). A hard DELETE is either refused or would
--   cascade through the loyalty ledger (financial evidence). So the customer ROW stays as a shell whose direct identifiers are irreversibly
--   removed; auth, recovery, notification and contact data are deleted; financial, consent and sanction records stay (pseudonymous, linked
--   to the identity-free shell). Because the shell holds no identifier, the audit paths event -> audit_log -> membershipId -> customer and
--   audit time -> membership.joined_at -> customer no longer lead to a person. Behavioural/ledger history that remains is PSEUDONYMOUS, not
--   anonymous: it is retained for stated financial/security purposes only and is never described as anonymization.
--
-- NOTHING IS CALLABLE BY THE APPLICATION RUNTIME. Every function below is SECURITY DEFINER, owned by the internal NOLOGIN role
-- customer_privacy_owner, has a fixed search_path, no dynamic SQL, EXECUTE revoked from PUBLIC, and EXECUTE granted ONLY to
-- customer_privacy_operator, a NOLOGIN role that has NO MEMBERS until the Owner approves an operator workflow (R5). No request, hold or
-- retention policy exists, and the retention policy cannot be enabled without an approver and an approval reference.
-- =====================================================================================================================================
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['customer_privacy_owner','customer_privacy_operator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole)) THEN
      RAISE EXCEPTION 'D2FINAL: role % exists with unsafe attributes (superuser, BYPASSRLS, LOGIN or CREATEROLE); refusing to continue', r;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT pg_has_role(current_user, 'customer_privacy_owner', 'SET') THEN
      GRANT customer_privacy_owner TO CURRENT_USER;
      PERFORM set_config('d2f.membership_granted', 'on', false);
    END IF;
    IF NOT has_schema_privilege('customer_privacy_owner', 'public', 'CREATE') THEN
      GRANT CREATE ON SCHEMA public TO customer_privacy_owner;
      PERFORM set_config('d2f.schema_create_granted', 'on', false);
    END IF;
    -- Needed only to GRANT EXECUTE on the 0084 erasure function (owned by onboarding_erasure_owner) to customer_privacy_owner; removed at the end.
    IF NOT pg_has_role(current_user, 'onboarding_erasure_owner', 'USAGE') THEN
      GRANT onboarding_erasure_owner TO CURRENT_USER;
      PERFORM set_config('d2f.erasure_owner_membership_granted', 'on', false);
    END IF;
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. The customer shell: anonymized_at, an irreversible, database-enforced shape, and no new activity for an anonymized customer.
-- ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.customers ADD COLUMN anonymized_at timestamp with time zone;--> statement-breakpoint
ALTER TABLE public.customers ADD CONSTRAINT customers_anonymized_shape_check CHECK (
  anonymized_at IS NULL OR (phone IS NULL AND full_name IS NULL AND email IS NULL AND birthday IS NULL AND phone_verified_at IS NULL AND preferred_locale IS NULL)
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.customer_anonymization_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF OLD.anonymized_at IS NOT NULL THEN
    IF NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at THEN
      RAISE EXCEPTION 'CUSTOMER_ANONYMIZATION_IRREVERSIBLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.anonymized_at IS NOT NULL AND current_user <> 'customer_privacy_owner' THEN
    RAISE EXCEPTION 'CUSTOMER_ANONYMIZATION_RESTRICTED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER customer_anonymization_guard_trg BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.customer_anonymization_guard();--> statement-breakpoint
ALTER TABLE public.customers ENABLE ALWAYS TRIGGER customer_anonymization_guard_trg;--> statement-breakpoint
-- An anonymized customer can gain no membership, credential or session. FOR SHARE serializes this check against the anonymization (which
-- holds the customer row FOR UPDATE), so an insert that races it either finishes first (and is then removed) or fails afterwards.
CREATE OR REPLACE FUNCTION public.customer_not_anonymized_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE gone timestamptz;
BEGIN
  SELECT c.anonymized_at INTO gone FROM public.customers c WHERE c.id = NEW.customer_id FOR SHARE;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER customer_not_anonymized_guard_trg BEFORE INSERT ON public.business_customer_memberships FOR EACH ROW EXECUTE FUNCTION public.customer_not_anonymized_guard();--> statement-breakpoint
CREATE TRIGGER customer_not_anonymized_guard_trg BEFORE INSERT ON public.customer_credentials FOR EACH ROW EXECUTE FUNCTION public.customer_not_anonymized_guard();--> statement-breakpoint
CREATE TRIGGER customer_not_anonymized_guard_trg BEFORE INSERT ON public.customer_sessions FOR EACH ROW EXECUTE FUNCTION public.customer_not_anonymized_guard();--> statement-breakpoint
-- A rejoin reactivates an existing membership by UPDATE (no membership INSERT), so the event insert is guarded too: no new onboarding event can name an anonymized customer.
CREATE TRIGGER customer_not_anonymized_guard_trg BEFORE INSERT ON public.customer_onboarding_events FOR EACH ROW EXECUTE FUNCTION public.customer_not_anonymized_guard();--> statement-breakpoint
ALTER TABLE public.business_customer_memberships ENABLE ALWAYS TRIGGER customer_not_anonymized_guard_trg;--> statement-breakpoint
ALTER TABLE public.customer_credentials ENABLE ALWAYS TRIGGER customer_not_anonymized_guard_trg;--> statement-breakpoint
ALTER TABLE public.customer_sessions ENABLE ALWAYS TRIGGER customer_not_anonymized_guard_trg;--> statement-breakpoint
ALTER TABLE public.customer_onboarding_events ENABLE ALWAYS TRIGGER customer_not_anonymized_guard_trg;--> statement-breakpoint

-- TRUNCATE is denied on every table this migration put a row guard on (repository rule: a row-guarded table also denies TRUNCATE); the runtime role
-- never held TRUNCATE, and a cascade from a parent now fails as a whole instead of emptying customer identity tables.
CREATE OR REPLACE FUNCTION public.customer_identity_truncate_denied() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  RAISE EXCEPTION 'CUSTOMER_IDENTITY_TRUNCATE_DENIED (%.%)', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;--> statement-breakpoint
CREATE TRIGGER customers_no_truncate BEFORE TRUNCATE ON public.customers FOR EACH STATEMENT EXECUTE FUNCTION public.customer_identity_truncate_denied();--> statement-breakpoint
CREATE TRIGGER business_customer_memberships_no_truncate BEFORE TRUNCATE ON public.business_customer_memberships FOR EACH STATEMENT EXECUTE FUNCTION public.customer_identity_truncate_denied();--> statement-breakpoint
CREATE TRIGGER customer_credentials_no_truncate BEFORE TRUNCATE ON public.customer_credentials FOR EACH STATEMENT EXECUTE FUNCTION public.customer_identity_truncate_denied();--> statement-breakpoint
CREATE TRIGGER customer_sessions_no_truncate BEFORE TRUNCATE ON public.customer_sessions FOR EACH STATEMENT EXECUTE FUNCTION public.customer_identity_truncate_denied();--> statement-breakpoint
ALTER TABLE public.customers ENABLE ALWAYS TRIGGER customers_no_truncate;--> statement-breakpoint
ALTER TABLE public.business_customer_memberships ENABLE ALWAYS TRIGGER business_customer_memberships_no_truncate;--> statement-breakpoint
ALTER TABLE public.customer_credentials ENABLE ALWAYS TRIGGER customer_credentials_no_truncate;--> statement-breakpoint
ALTER TABLE public.customer_sessions ENABLE ALWAYS TRIGGER customer_sessions_no_truncate;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Tables. No personal data beyond the pseudonymous customer id; no free text (codes and reference patterns only).
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE public.privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_ref text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  kind text NOT NULL DEFAULT 'erasure',
  channel text NOT NULL,
  state text NOT NULL DEFAULT 'submitted',
  verification_method text,
  verification_evidence_ref text,
  verified_at timestamp with time zone,
  verified_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at timestamp with time zone,
  approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decision_code text,
  failure_code text,
  sever_cashier boolean NOT NULL DEFAULT false,
  scrub_feedback_contacts boolean NOT NULL DEFAULT false,
  delete_conversations boolean NOT NULL DEFAULT false,
  events_severed integer NOT NULL DEFAULT 0,
  events_deferred integer NOT NULL DEFAULT 0,
  sessions_deleted integer NOT NULL DEFAULT 0,
  credentials_deleted integer NOT NULL DEFAULT 0,
  recovery_deleted integer NOT NULL DEFAULT 0,
  notifications_deleted integer NOT NULL DEFAULT 0,
  feedback_scrubbed integer NOT NULL DEFAULT 0,
  conversations_deleted integer NOT NULL DEFAULT 0,
  otp_deleted integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  CONSTRAINT privacy_requests_ref_check CHECK (request_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CONSTRAINT privacy_requests_kind_check CHECK (kind = 'erasure'),
  CONSTRAINT privacy_requests_channel_check CHECK (channel IN ('customer_authenticated', 'platform_assisted')),
  CONSTRAINT privacy_requests_state_check CHECK (state IN ('submitted','identity_verification_required','identity_verified','scope_assessment','retention_assessment','approved','rejected','processing','completed','failed')),
  CONSTRAINT privacy_requests_method_check CHECK (verification_method IS NULL OR verification_method IN ('customer_reauthentication', 'out_of_band_platform_verified')),
  CONSTRAINT privacy_requests_evidence_ref_check CHECK (verification_evidence_ref IS NULL OR verification_evidence_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CONSTRAINT privacy_requests_decision_check CHECK (decision_code IS NULL OR decision_code IN ('approved','rejected_unverified','rejected_out_of_scope','rejected_retention_obligation','rejected_duplicate','rejected_withdrawn')),
  CONSTRAINT privacy_requests_failure_check CHECK (failure_code IS NULL OR failure_code IN ('LEGAL_HOLD_ACTIVE','PROCESSING_ERROR')),
  CONSTRAINT privacy_requests_verified_shape_check CHECK (
    (verified_at IS NULL AND verified_by IS NULL AND verification_method IS NULL AND verification_evidence_ref IS NULL)
    OR (verified_at IS NOT NULL AND verification_method IS NOT NULL AND verification_evidence_ref IS NOT NULL)
  ),
  CONSTRAINT privacy_requests_approved_requires_verified_check CHECK (approved_at IS NULL OR verified_at IS NOT NULL),
  CONSTRAINT privacy_requests_counts_check CHECK (events_severed >= 0 AND events_deferred >= 0 AND sessions_deleted >= 0 AND credentials_deleted >= 0 AND recovery_deleted >= 0
    AND notifications_deleted >= 0 AND feedback_scrubbed >= 0 AND conversations_deleted >= 0 AND otp_deleted >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX privacy_requests_ref_unique ON public.privacy_requests (request_ref);--> statement-breakpoint
-- Replay protection: one verification proof can be used by exactly one request.
CREATE UNIQUE INDEX privacy_requests_evidence_ref_unique ON public.privacy_requests (verification_evidence_ref) WHERE verification_evidence_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX privacy_requests_customer_idx ON public.privacy_requests (customer_id, state);--> statement-breakpoint
CREATE TABLE public.privacy_request_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  request_id uuid NOT NULL REFERENCES public.privacy_requests(id) ON DELETE RESTRICT,
  from_state text,
  to_state text NOT NULL,
  actor_role text NOT NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  evidence_ref text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT privacy_transitions_evidence_ref_check CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[A-Za-z0-9._:-]{1,64}$')
);--> statement-breakpoint
CREATE INDEX privacy_request_transitions_request_idx ON public.privacy_request_transitions (request_id, seq);--> statement-breakpoint
CREATE TABLE public.legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  reason_code text NOT NULL,
  hold_ref text NOT NULL,
  placed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  placed_at timestamp with time zone NOT NULL DEFAULT now(),
  released_at timestamp with time zone,
  released_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT legal_holds_reason_check CHECK (reason_code IN ('legal_proceeding','regulatory_inquiry','fraud_investigation','financial_record_retention','other_approved')),
  CONSTRAINT legal_holds_ref_check CHECK (hold_ref ~ '^[A-Za-z0-9._:-]{1,64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX legal_holds_ref_unique ON public.legal_holds (hold_ref);--> statement-breakpoint
CREATE INDEX legal_holds_active_idx ON public.legal_holds (customer_id) WHERE released_at IS NULL;--> statement-breakpoint
CREATE TABLE public.retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  version integer NOT NULL,
  period_days integer,
  trigger_kind text NOT NULL DEFAULT 'age_since_occurred',
  sever_cashier boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approval_ref text,
  approved_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT retention_policies_category_check CHECK (category IN ('customer_onboarding_events')),
  CONSTRAINT retention_policies_trigger_check CHECK (trigger_kind IN ('age_since_occurred')),
  CONSTRAINT retention_policies_period_check CHECK (period_days IS NULL OR period_days BETWEEN 1 AND 36500),
  CONSTRAINT retention_policies_ref_check CHECK (approval_ref IS NULL OR approval_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  -- A disabled policy is the default. Enabling needs a period, an approver and an approval reference: no invented retention.
  CONSTRAINT retention_policies_enabled_requires_approval_check CHECK (NOT enabled OR (period_days IS NOT NULL AND approved_by IS NOT NULL AND approval_ref IS NOT NULL AND approved_at IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX retention_policies_category_version_unique ON public.retention_policies (category, version);--> statement-breakpoint
CREATE TABLE public.retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid REFERENCES public.retention_policies(id) ON DELETE RESTRICT,
  category text NOT NULL,
  mode text NOT NULL,
  period_days integer NOT NULL,
  candidate_pairs integer NOT NULL DEFAULT 0,
  candidate_events integer NOT NULL DEFAULT 0,
  held_pairs integer NOT NULL DEFAULT 0,
  processed_pairs integer NOT NULL DEFAULT 0,
  deferred_events integer NOT NULL DEFAULT 0,
  failed_pairs integer NOT NULL DEFAULT 0,
  operator_role text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT retention_runs_mode_check CHECK (mode IN ('dry_run', 'execute')),
  CONSTRAINT retention_runs_policy_check CHECK ((mode = 'execute') = (policy_id IS NOT NULL)),
  CONSTRAINT retention_runs_counts_check CHECK (candidate_pairs >= 0 AND candidate_events >= 0 AND held_pairs >= 0 AND processed_pairs >= 0 AND deferred_events >= 0 AND failed_pairs >= 0)
);--> statement-breakpoint
REVOKE ALL ON TABLE public.privacy_requests, public.privacy_request_transitions, public.legal_holds, public.retention_policies, public.retention_runs FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Database-enforced state machine and append-only evidence.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.privacy_transition_allowed(p_from text, p_to text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT (p_from, p_to) IN (
    ('submitted','identity_verification_required'), ('submitted','rejected'),
    ('identity_verification_required','identity_verified'), ('identity_verification_required','rejected'),
    ('identity_verified','scope_assessment'), ('identity_verified','rejected'),
    ('scope_assessment','retention_assessment'), ('scope_assessment','rejected'),
    ('retention_assessment','approved'), ('retention_assessment','rejected'),
    ('approved','processing'),
    ('processing','completed'), ('processing','failed'),
    ('failed','processing')
  )
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.privacy_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_APPEND_ONLY (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'submitted' OR NEW.verified_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'PRIVACY_REQUEST_MUST_START_SUBMITTED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user <> 'customer_privacy_owner' THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_RESTRICTED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.request_ref IS DISTINCT FROM OLD.request_ref OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_IDENTITY_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT public.privacy_transition_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_TRANSITION_INVALID (% -> %)', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('rejected', 'completed') THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_TERMINAL' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.verified_at IS NOT NULL AND (NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verification_method IS DISTINCT FROM OLD.verification_method OR NEW.verification_evidence_ref IS DISTINCT FROM OLD.verification_evidence_ref) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_VERIFICATION_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'approved' AND (NEW.verified_at IS NULL OR NEW.approved_by IS NULL OR NEW.approved_by IS NOT DISTINCT FROM NEW.verified_by) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_APPROVAL_SEPARATION_OF_DUTIES' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER privacy_request_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.privacy_requests FOR EACH ROW EXECUTE FUNCTION public.privacy_request_guard();--> statement-breakpoint
CREATE TRIGGER privacy_requests_no_truncate BEFORE TRUNCATE ON public.privacy_requests FOR EACH STATEMENT EXECUTE FUNCTION public.privacy_request_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.privacy_append_only_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  RAISE EXCEPTION 'PRIVACY_EVIDENCE_APPEND_ONLY (%.%, %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;--> statement-breakpoint
CREATE TRIGGER privacy_request_transitions_guard_trg BEFORE UPDATE OR DELETE ON public.privacy_request_transitions FOR EACH ROW EXECUTE FUNCTION public.privacy_append_only_guard();--> statement-breakpoint
CREATE TRIGGER privacy_request_transitions_no_truncate BEFORE TRUNCATE ON public.privacy_request_transitions FOR EACH STATEMENT EXECUTE FUNCTION public.privacy_append_only_guard();--> statement-breakpoint
CREATE TRIGGER retention_runs_guard_trg BEFORE UPDATE OR DELETE ON public.retention_runs FOR EACH ROW EXECUTE FUNCTION public.privacy_append_only_guard();--> statement-breakpoint
CREATE TRIGGER retention_runs_no_truncate BEFORE TRUNCATE ON public.retention_runs FOR EACH STATEMENT EXECUTE FUNCTION public.privacy_append_only_guard();--> statement-breakpoint
-- Legal holds and retention policies: never deleted; changed only by the privacy owner role and only in the one sanctioned way.
-- (Two functions, not one: PL/pgSQL resolves NEW.<column> against the trigger's own table, so each table needs its own.)
CREATE OR REPLACE FUNCTION public.legal_hold_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'PRIVACY_REGISTRY_NO_DELETE (legal_holds)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.released_by IS NOT NULL THEN
      RAISE EXCEPTION 'LEGAL_HOLD_MUST_START_ACTIVE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user <> 'customer_privacy_owner' THEN
    RAISE EXCEPTION 'PRIVACY_REGISTRY_RESTRICTED (legal_holds)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR NEW.id IS DISTINCT FROM OLD.id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.hold_ref IS DISTINCT FROM OLD.hold_ref
     OR NEW.placed_by IS DISTINCT FROM OLD.placed_by OR NEW.placed_at IS DISTINCT FROM OLD.placed_at THEN
    RAISE EXCEPTION 'LEGAL_HOLD_ONLY_RELEASABLE_ONCE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retention_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'PRIVACY_REGISTRY_NO_DELETE (retention_policies)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.enabled THEN
      RAISE EXCEPTION 'RETENTION_POLICY_MUST_START_DISABLED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user <> 'customer_privacy_owner' THEN
    RAISE EXCEPTION 'PRIVACY_REGISTRY_RESTRICTED (retention_policies)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.category IS DISTINCT FROM OLD.category OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.period_days IS DISTINCT FROM OLD.period_days OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.sever_cashier IS DISTINCT FROM OLD.sever_cashier OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'RETENTION_POLICY_CONTENT_IMMUTABLE (register a new version)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER legal_holds_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.legal_holds FOR EACH ROW EXECUTE FUNCTION public.legal_hold_guard();--> statement-breakpoint
CREATE TRIGGER legal_holds_no_truncate BEFORE TRUNCATE ON public.legal_holds FOR EACH STATEMENT EXECUTE FUNCTION public.legal_hold_guard();--> statement-breakpoint
CREATE TRIGGER retention_policies_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.retention_policies FOR EACH ROW EXECUTE FUNCTION public.retention_policy_guard();--> statement-breakpoint
CREATE TRIGGER retention_policies_no_truncate BEFORE TRUNCATE ON public.retention_policies FOR EACH STATEMENT EXECUTE FUNCTION public.retention_policy_guard();--> statement-breakpoint
ALTER TABLE public.privacy_requests ENABLE ALWAYS TRIGGER privacy_request_guard_trg;--> statement-breakpoint
ALTER TABLE public.privacy_requests ENABLE ALWAYS TRIGGER privacy_requests_no_truncate;--> statement-breakpoint
ALTER TABLE public.privacy_request_transitions ENABLE ALWAYS TRIGGER privacy_request_transitions_guard_trg;--> statement-breakpoint
ALTER TABLE public.privacy_request_transitions ENABLE ALWAYS TRIGGER privacy_request_transitions_no_truncate;--> statement-breakpoint
ALTER TABLE public.retention_runs ENABLE ALWAYS TRIGGER retention_runs_guard_trg;--> statement-breakpoint
ALTER TABLE public.retention_runs ENABLE ALWAYS TRIGGER retention_runs_no_truncate;--> statement-breakpoint
ALTER TABLE public.legal_holds ENABLE ALWAYS TRIGGER legal_holds_guard_trg;--> statement-breakpoint
ALTER TABLE public.legal_holds ENABLE ALWAYS TRIGGER legal_holds_no_truncate;--> statement-breakpoint
ALTER TABLE public.retention_policies ENABLE ALWAYS TRIGGER retention_policies_guard_trg;--> statement-breakpoint
ALTER TABLE public.retention_policies ENABLE ALWAYS TRIGGER retention_policies_no_truncate;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Privileges: the owner role gets exactly what the functions need; the operator role reads the workflow tables and executes the functions.
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON TABLE public.privacy_requests, public.legal_holds, public.retention_policies TO customer_privacy_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.privacy_request_transitions, public.retention_runs TO customer_privacy_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.privacy_requests, public.privacy_request_transitions, public.legal_holds, public.retention_policies, public.retention_runs TO customer_privacy_operator;--> statement-breakpoint
GRANT SELECT (id, status, platform_role) ON TABLE public.users TO customer_privacy_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.customers, public.business_customer_memberships, public.customer_onboarding_events, public.businesses TO customer_privacy_owner;--> statement-breakpoint
GRANT UPDATE (phone, full_name, email, birthday, phone_verified_at, preferred_locale, qr_revocation_epoch, anonymized_at, updated_at) ON TABLE public.customers TO customer_privacy_owner;--> statement-breakpoint
GRANT UPDATE (onboarding_reference) ON TABLE public.business_customer_memberships TO customer_privacy_owner;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE public.customer_sessions, public.customer_credentials, public.customer_recovery_attempts, public.customer_recovery_codes, public.customer_recovery_code_sets,
  public.customer_auth_challenges, public.customer_action_authorizations, public.notifications, public.notification_preferences, public.conversations TO customer_privacy_owner;--> statement-breakpoint
GRANT DELETE ON TABLE public.otp_codes, public.otp_request_cooldowns TO customer_privacy_owner;--> statement-breakpoint
GRANT SELECT (phone) ON TABLE public.otp_codes, public.otp_request_cooldowns TO customer_privacy_owner;--> statement-breakpoint
GRANT SELECT (id, customer_phone, customer_email), UPDATE (customer_name, customer_email, customer_phone) ON TABLE public.feedback TO customer_privacy_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.onboarding_erase_customer_events(uuid, uuid, text, boolean) TO customer_privacy_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. Workflow functions (operator-only). Submission, verification, assessment, approval and rejection are separate, recorded steps.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.privacy_request_submit(p_customer_id uuid, p_request_ref text, p_channel text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE c public.customers%ROWTYPE; existing public.privacy_requests%ROWTYPE; new_id uuid;
BEGIN
  IF p_customer_id IS NULL OR p_request_ref IS NULL OR p_request_ref !~ '^[A-Za-z0-9._:-]{1,64}$' OR p_channel NOT IN ('customer_authenticated', 'platform_assisted') THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_ARGUMENT_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO existing FROM public.privacy_requests WHERE request_ref = p_request_ref;
  IF FOUND THEN
    IF existing.customer_id <> p_customer_id OR existing.channel <> p_channel THEN
      RAISE EXCEPTION 'PRIVACY_REQUEST_REF_CONFLICT' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN existing.id; -- replay of the same submission: idempotent
  END IF;
  SELECT * INTO c FROM public.customers WHERE id = p_customer_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REQUEST_CUSTOMER_UNKNOWN' USING ERRCODE = 'no_data_found'; END IF;
  IF c.anonymized_at IS NOT NULL THEN RAISE EXCEPTION 'PRIVACY_REQUEST_CUSTOMER_ALREADY_ANONYMIZED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  INSERT INTO public.privacy_requests (request_ref, customer_id, channel) VALUES (p_request_ref, p_customer_id, p_channel) RETURNING id INTO new_id;
  INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role) VALUES (new_id, NULL, 'submitted', session_user);
  RETURN new_id;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.privacy_request_advance(p_request_id uuid, p_to_state text, p_actor_user_id uuid, p_evidence_ref text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE r public.privacy_requests%ROWTYPE;
BEGIN
  IF p_to_state NOT IN ('identity_verification_required', 'scope_assessment', 'retention_assessment') THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_USE_DEDICATED_FUNCTION (%)', p_to_state USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM public.privacy_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.status = 'active' AND u.platform_role IN ('support', 'admin')) THEN
    RAISE EXCEPTION 'PRIVACY_ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.privacy_requests SET state = p_to_state, updated_at = now() WHERE id = r.id;
  INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role, actor_user_id, evidence_ref)
    VALUES (r.id, r.state, p_to_state, session_user, p_actor_user_id, p_evidence_ref);
  RETURN p_to_state;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.privacy_request_record_verification(p_request_id uuid, p_method text, p_evidence_ref text, p_actor_user_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE r public.privacy_requests%ROWTYPE;
BEGIN
  IF p_method NOT IN ('customer_reauthentication', 'out_of_band_platform_verified') OR p_evidence_ref IS NULL OR p_evidence_ref !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
    RAISE EXCEPTION 'PRIVACY_VERIFICATION_ARGUMENT_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM public.privacy_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  IF r.state <> 'identity_verification_required' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_STATE_INVALID (%)', r.state USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF r.channel = 'customer_authenticated' AND p_method <> 'customer_reauthentication' THEN
    RAISE EXCEPTION 'PRIVACY_VERIFICATION_METHOD_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.status = 'active' AND u.platform_role IN ('support', 'admin')) THEN
    RAISE EXCEPTION 'PRIVACY_ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- a proof can be used once: the unique index on verification_evidence_ref rejects a replay with 23505
  UPDATE public.privacy_requests SET state = 'identity_verified', verification_method = p_method, verification_evidence_ref = p_evidence_ref,
    verified_at = now(), verified_by = p_actor_user_id, updated_at = now() WHERE id = r.id;
  INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role, actor_user_id, evidence_ref)
    VALUES (r.id, r.state, 'identity_verified', session_user, p_actor_user_id, p_evidence_ref);
  RETURN 'identity_verified';
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.privacy_request_approve(p_request_id uuid, p_actor_user_id uuid, p_evidence_ref text,
  p_sever_cashier boolean DEFAULT false, p_scrub_feedback_contacts boolean DEFAULT false, p_delete_conversations boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE r public.privacy_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.privacy_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  IF r.state <> 'retention_assessment' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_STATE_INVALID (%)', r.state USING ERRCODE = 'integrity_constraint_violation'; END IF;
  -- approval needs a different, active platform ADMIN than the verifier (separation of duties; also enforced by the table guard)
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.status = 'active' AND u.platform_role = 'admin') OR p_actor_user_id IS NOT DISTINCT FROM r.verified_by THEN
    RAISE EXCEPTION 'PRIVACY_ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.privacy_requests SET state = 'approved', approved_at = now(), approved_by = p_actor_user_id, decision_code = 'approved',
    sever_cashier = COALESCE(p_sever_cashier, false), scrub_feedback_contacts = COALESCE(p_scrub_feedback_contacts, false),
    delete_conversations = COALESCE(p_delete_conversations, false), updated_at = now() WHERE id = r.id;
  INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role, actor_user_id, evidence_ref)
    VALUES (r.id, r.state, 'approved', session_user, p_actor_user_id, p_evidence_ref);
  RETURN 'approved';
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.privacy_request_reject(p_request_id uuid, p_actor_user_id uuid, p_decision_code text, p_evidence_ref text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE r public.privacy_requests%ROWTYPE;
BEGIN
  IF p_decision_code NOT IN ('rejected_unverified','rejected_out_of_scope','rejected_retention_obligation','rejected_duplicate','rejected_withdrawn') THEN
    RAISE EXCEPTION 'PRIVACY_DECISION_CODE_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM public.privacy_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.status = 'active' AND u.platform_role IN ('support', 'admin')) THEN
    RAISE EXCEPTION 'PRIVACY_ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.privacy_requests SET state = 'rejected', decision_code = p_decision_code, updated_at = now(), completed_at = now() WHERE id = r.id;
  INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role, actor_user_id, evidence_ref)
    VALUES (r.id, r.state, 'rejected', session_user, p_actor_user_id, p_evidence_ref);
  RETURN 'rejected';
END
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. Legal holds.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.legal_hold_place(p_customer_id uuid, p_business_id uuid, p_reason_code text, p_hold_ref text, p_actor_user_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE new_id uuid; existing public.legal_holds%ROWTYPE;
BEGIN
  IF p_hold_ref IS NULL OR p_hold_ref !~ '^[A-Za-z0-9._:-]{1,64}$' OR p_reason_code NOT IN ('legal_proceeding','regulatory_inquiry','fraud_investigation','financial_record_retention','other_approved') THEN
    RAISE EXCEPTION 'LEGAL_HOLD_ARGUMENT_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.status = 'active' AND u.platform_role = 'admin') THEN
    RAISE EXCEPTION 'PRIVACY_ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO existing FROM public.legal_holds WHERE hold_ref = p_hold_ref;
  IF FOUND THEN
    IF existing.customer_id <> p_customer_id OR existing.business_id IS DISTINCT FROM p_business_id OR existing.reason_code <> p_reason_code THEN RAISE EXCEPTION 'LEGAL_HOLD_REF_CONFLICT' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN existing.id;
  END IF;
  -- FOR SHARE on the customer row serializes against an anonymization in flight (which holds it FOR UPDATE and re-checks holds afterwards)
  PERFORM 1 FROM public.customers WHERE id = p_customer_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEGAL_HOLD_CUSTOMER_UNKNOWN' USING ERRCODE = 'no_data_found'; END IF;
  INSERT INTO public.legal_holds (customer_id, business_id, reason_code, hold_ref, placed_by) VALUES (p_customer_id, p_business_id, p_reason_code, p_hold_ref, p_actor_user_id) RETURNING id INTO new_id;
  RETURN new_id;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.legal_hold_release(p_hold_id uuid, p_actor_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.status = 'active' AND u.platform_role = 'admin') THEN
    RAISE EXCEPTION 'PRIVACY_ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.legal_holds SET released_at = now(), released_by = p_actor_user_id WHERE id = p_hold_id AND released_at IS NULL;
  RETURN FOUND; -- false when already released or unknown: idempotent
END
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. The anonymization itself. One transaction; idempotent; refuses while a legal hold is active; relationship locks first (the same
--    protocol as join/leave/withdrawal/erasure), then the customer row; direct identifiers removed, financial/consent/sanction records kept.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.privacy_anonymize_customer(p_request_id uuid)
RETURNS TABLE (out_request_id uuid, out_outcome text, out_events_severed integer, out_events_deferred integer, out_sessions_deleted integer,
  out_credentials_deleted integer, out_recovery_deleted integer, out_notifications_deleted integer, out_feedback_scrubbed integer,
  out_conversations_deleted integer, out_otp_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  req public.privacy_requests%ROWTYPE;
  cust public.customers%ROWTYPE;
  biz record;
  prior_state text;
  old_phone text; old_email text;
  n_ev integer := 0; n_def integer := 0; e integer; d integer;
  n_sessions integer := 0; n_cred integer := 0; n_rec integer := 0; n_notif integer := 0; n_fb integer := 0; n_conv integer := 0; n_otp integer := 0; k integer;
BEGIN
  SELECT * INTO req FROM public.privacy_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  -- locks FIRST (advisory per relationship, sorted), then the request row, then the customer row: the same order as join/leave
  FOR biz IN SELECT DISTINCT m.business_id FROM public.business_customer_memberships m WHERE m.customer_id = req.customer_id ORDER BY m.business_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('customer_business_relationship:' || req.customer_id::text || ':' || biz.business_id::text, 0));
  END LOOP;
  SELECT * INTO req FROM public.privacy_requests WHERE id = p_request_id FOR UPDATE;
  IF req.state = 'completed' THEN
    RETURN QUERY SELECT req.id, 'noop'::text, req.events_severed, req.events_deferred, req.sessions_deleted, req.credentials_deleted, req.recovery_deleted,
      req.notifications_deleted, req.feedback_scrubbed, req.conversations_deleted, req.otp_deleted;
    RETURN;
  END IF;
  IF req.state NOT IN ('approved', 'failed') THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOT_APPROVED (%)', req.state USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT * INTO cust FROM public.customers WHERE id = req.customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRIVACY_REQUEST_CUSTOMER_UNKNOWN' USING ERRCODE = 'no_data_found'; END IF;
  prior_state := req.state;
  UPDATE public.privacy_requests SET state = 'processing', failure_code = NULL, updated_at = now() WHERE id = req.id;
  INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role) VALUES (req.id, prior_state, 'processing', session_user);
  -- A legal hold is a recorded restriction, not an erasure: nothing is changed and the request ends FAILED (retry after release).
  IF EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.customer_id = req.customer_id AND h.released_at IS NULL) THEN
    UPDATE public.privacy_requests SET state = 'failed', failure_code = 'LEGAL_HOLD_ACTIVE', updated_at = now() WHERE id = req.id;
    INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role) VALUES (req.id, 'processing', 'failed', session_user);
    RETURN QUERY SELECT req.id, 'restricted'::text, 0, 0, 0, 0, 0, 0, 0, 0, 0;
    RETURN;
  END IF;
  IF cust.anonymized_at IS NOT NULL THEN
    UPDATE public.privacy_requests SET state = 'completed', completed_at = now(), updated_at = now() WHERE id = req.id;
    INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role) VALUES (req.id, 'processing', 'completed', session_user);
    RETURN QUERY SELECT req.id, 'noop'::text, 0, 0, 0, 0, 0, 0, 0, 0, 0;
    RETURN;
  END IF;
  old_phone := cust.phone; old_email := cust.email;

  -- onboarding events of every business (0084): links severed, times generalized; assisted events younger than the invitation lifetime are deferred
  FOR biz IN SELECT DISTINCT ev.business_id FROM public.customer_onboarding_events ev WHERE ev.customer_id = cust.id AND ev.erased_at IS NULL ORDER BY ev.business_id LOOP
    SELECT r2.out_events_erased, r2.out_events_deferred INTO e, d
      FROM public.onboarding_erase_customer_events(biz.business_id, cust.id, 'prv:' || replace(req.id::text, '-', ''), req.sever_cashier) r2;
    n_ev := n_ev + COALESCE(e, 0); n_def := n_def + COALESCE(d, 0);
  END LOOP;

  -- authentication, recovery and contact data: deleted
  DELETE FROM public.customer_sessions WHERE customer_id = cust.id; GET DIAGNOSTICS n_sessions = ROW_COUNT; -- refresh tokens cascade
  DELETE FROM public.customer_credentials WHERE customer_id = cust.id; GET DIAGNOSTICS n_cred = ROW_COUNT;
  DELETE FROM public.customer_recovery_codes WHERE customer_id = cust.id; GET DIAGNOSTICS k = ROW_COUNT; n_rec := n_rec + k;
  DELETE FROM public.customer_recovery_code_sets WHERE customer_id = cust.id; GET DIAGNOSTICS k = ROW_COUNT; n_rec := n_rec + k;
  DELETE FROM public.customer_recovery_attempts WHERE customer_id = cust.id; GET DIAGNOSTICS k = ROW_COUNT; n_rec := n_rec + k;
  DELETE FROM public.customer_auth_challenges WHERE customer_id = cust.id; GET DIAGNOSTICS k = ROW_COUNT; n_rec := n_rec + k;
  DELETE FROM public.customer_action_authorizations WHERE customer_id = cust.id; GET DIAGNOSTICS k = ROW_COUNT; n_rec := n_rec + k;
  DELETE FROM public.notifications WHERE customer_id = cust.id; GET DIAGNOSTICS n_notif = ROW_COUNT;
  DELETE FROM public.notification_preferences WHERE customer_id = cust.id;
  IF old_phone IS NOT NULL THEN
    DELETE FROM public.otp_codes WHERE phone = old_phone; GET DIAGNOSTICS n_otp = ROW_COUNT;
    DELETE FROM public.otp_request_cooldowns WHERE phone = old_phone; GET DIAGNOSTICS k = ROW_COUNT; n_otp := n_otp + k;
  END IF;
  -- contact data the customer typed into feedback (matched by phone or email); the feedback text and ratings stay with the business
  IF req.scrub_feedback_contacts AND (old_phone IS NOT NULL OR old_email IS NOT NULL) THEN
    UPDATE public.feedback SET customer_name = NULL, customer_email = NULL, customer_phone = NULL
     WHERE (old_phone IS NOT NULL AND customer_phone = old_phone) OR (old_email IS NOT NULL AND lower(customer_email) = lower(old_email));
    GET DIAGNOSTICS n_fb = ROW_COUNT;
  END IF;
  IF req.delete_conversations THEN
    DELETE FROM public.conversations WHERE customer_id = cust.id; GET DIAGNOSTICS n_conv = ROW_COUNT; -- messages cascade
  END IF;
  UPDATE public.business_customer_memberships SET onboarding_reference = NULL WHERE customer_id = cust.id AND onboarding_reference IS NOT NULL;
  -- the shell: direct identifiers removed irreversibly; issued QR tokens invalidated; the row and its ledgers stay
  UPDATE public.customers SET phone = NULL, full_name = NULL, email = NULL, birthday = NULL, phone_verified_at = NULL, preferred_locale = NULL,
    qr_revocation_epoch = qr_revocation_epoch + 1, anonymized_at = now(), updated_at = now() WHERE id = cust.id;

  UPDATE public.privacy_requests SET state = 'completed', completed_at = now(), updated_at = now(), events_severed = n_ev, events_deferred = n_def,
    sessions_deleted = n_sessions, credentials_deleted = n_cred, recovery_deleted = n_rec, notifications_deleted = n_notif, feedback_scrubbed = n_fb,
    conversations_deleted = n_conv, otp_deleted = n_otp WHERE id = req.id;
  INSERT INTO public.privacy_request_transitions (request_id, from_state, to_state, actor_role) VALUES (req.id, 'processing', 'completed', session_user);
  RETURN QUERY SELECT req.id, 'completed'::text, n_ev, n_def, n_sessions, n_cred, n_rec, n_notif, n_fb, n_conv, n_otp;
END
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. Retention registry: versioned policies (disabled by default), a read-only dry-run preview, and a bounded executor for ONE category.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_policy_register(p_category text, p_version integer, p_period_days integer, p_sever_cashier boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE new_id uuid;
BEGIN
  IF p_category <> 'customer_onboarding_events' OR p_version IS NULL OR p_version < 1 OR (p_period_days IS NOT NULL AND p_period_days NOT BETWEEN 1 AND 36500) THEN
    RAISE EXCEPTION 'RETENTION_POLICY_ARGUMENT_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.retention_policies (category, version, period_days, sever_cashier) VALUES (p_category, p_version, p_period_days, COALESCE(p_sever_cashier, false)) RETURNING id INTO new_id;
  RETURN new_id; -- always DISABLED; enabling is a separate approved step
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retention_policy_approve(p_policy_id uuid, p_actor_user_id uuid, p_approval_ref text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_approval_ref IS NULL OR p_approval_ref !~ '^[A-Za-z0-9._:-]{1,64}$' THEN RAISE EXCEPTION 'RETENTION_APPROVAL_REF_INVALID' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id AND u.status = 'active' AND u.platform_role = 'admin') THEN
    RAISE EXCEPTION 'PRIVACY_ACTOR_NOT_AUTHORIZED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.retention_policies SET enabled = true, approved_by = p_actor_user_id, approval_ref = p_approval_ref, approved_at = now() WHERE id = p_policy_id AND NOT enabled;
  RETURN FOUND;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retention_policy_disable(p_policy_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  UPDATE public.retention_policies SET enabled = false WHERE id = p_policy_id AND enabled;
  RETURN FOUND;
END
$fn$;--> statement-breakpoint
-- Read-only: models a period WITHOUT deleting anything (works while every policy is disabled; this is how the Owner sees the impact of a period).
CREATE OR REPLACE FUNCTION public.retention_preview_onboarding_events(p_period_days integer)
RETURNS TABLE (out_candidate_pairs integer, out_candidate_events integer, out_held_pairs integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE cutoff timestamptz; pairs integer; evs integer; held integer;
BEGIN
  IF p_period_days IS NULL OR p_period_days NOT BETWEEN 1 AND 36500 THEN RAISE EXCEPTION 'RETENTION_PERIOD_INVALID' USING ERRCODE = 'invalid_parameter_value'; END IF;
  cutoff := now() - make_interval(days => p_period_days);
  WITH eligible AS (
    SELECT ev.business_id, ev.customer_id, count(*) AS n FROM public.customer_onboarding_events ev
     WHERE ev.erased_at IS NULL AND ev.customer_id IS NOT NULL AND ev.occurred_at < cutoff GROUP BY ev.business_id, ev.customer_id
  ), flagged AS (
    SELECT e.*, EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.customer_id = e.customer_id AND h.released_at IS NULL AND (h.business_id IS NULL OR h.business_id = e.business_id)) AS is_held FROM eligible e
  )
  SELECT count(*) FILTER (WHERE NOT is_held)::integer, COALESCE(sum(n) FILTER (WHERE NOT is_held), 0)::integer, count(*) FILTER (WHERE is_held)::integer INTO pairs, evs, held FROM flagged;
  INSERT INTO public.retention_runs (policy_id, category, mode, period_days, candidate_pairs, candidate_events, held_pairs, operator_role)
    VALUES (NULL, 'customer_onboarding_events', 'dry_run', p_period_days, pairs, evs, held, session_user);
  RETURN QUERY SELECT pairs, evs, held;
END
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.retention_execute_onboarding_events(p_policy_id uuid, p_batch integer)
RETURNS TABLE (out_run_id uuid, out_processed_pairs integer, out_deferred_events integer, out_failed_pairs integer, out_held_pairs integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE pol public.retention_policies%ROWTYPE; cutoff timestamptz; pr record; done integer := 0; deferred integer := 0; failed integer := 0; held integer := 0; e integer; d integer; run_id uuid; cand integer := 0;
BEGIN
  IF p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'RETENTION_BATCH_INVALID' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO pol FROM public.retention_policies WHERE id = p_policy_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_POLICY_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT pol.enabled THEN RAISE EXCEPTION 'RETENTION_POLICY_NOT_ENABLED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  cutoff := now() - make_interval(days => pol.period_days);
  FOR pr IN
    SELECT ev.business_id, ev.customer_id FROM public.customer_onboarding_events ev
     WHERE ev.erased_at IS NULL AND ev.customer_id IS NOT NULL AND ev.occurred_at < cutoff
     GROUP BY ev.business_id, ev.customer_id ORDER BY ev.business_id, ev.customer_id LIMIT p_batch
  LOOP
    cand := cand + 1;
    IF EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.customer_id = pr.customer_id AND h.released_at IS NULL AND (h.business_id IS NULL OR h.business_id = pr.business_id)) THEN
      held := held + 1; CONTINUE;
    END IF;
    BEGIN
      SELECT r2.out_events_erased, r2.out_events_deferred INTO e, d FROM public.onboarding_erase_customer_events(pr.business_id, pr.customer_id, 'ret:' || replace(p_policy_id::text, '-', ''), pol.sever_cashier) r2;
      done := done + 1; deferred := deferred + COALESCE(d, 0);
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1; -- one pair failing does not poison the batch; it is retried by the next run
    END;
  END LOOP;
  INSERT INTO public.retention_runs (policy_id, category, mode, period_days, candidate_pairs, held_pairs, processed_pairs, deferred_events, failed_pairs, operator_role)
    VALUES (pol.id, pol.category, 'execute', pol.period_days, cand, held, done, deferred, failed, session_user) RETURNING id INTO run_id;
  RETURN QUERY SELECT run_id, done, deferred, failed, held;
END
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and execution rights: operator only; never PUBLIC; never the application runtime.
-- ---------------------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION public.privacy_request_submit(uuid, text, text) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.privacy_request_advance(uuid, text, uuid, text) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.privacy_request_record_verification(uuid, text, text, uuid) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.privacy_request_approve(uuid, uuid, text, boolean, boolean, boolean) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.privacy_request_reject(uuid, uuid, text, text) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.legal_hold_place(uuid, uuid, text, text, uuid) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.legal_hold_release(uuid, uuid) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.privacy_anonymize_customer(uuid) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.retention_policy_register(text, integer, integer, boolean) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.retention_policy_approve(uuid, uuid, text) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.retention_policy_disable(uuid) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.retention_preview_onboarding_events(integer) OWNER TO customer_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.retention_execute_onboarding_events(uuid, integer) OWNER TO customer_privacy_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.privacy_request_submit(uuid, text, text), public.privacy_request_advance(uuid, text, uuid, text), public.privacy_request_record_verification(uuid, text, text, uuid),
  public.privacy_request_approve(uuid, uuid, text, boolean, boolean, boolean), public.privacy_request_reject(uuid, uuid, text, text), public.legal_hold_place(uuid, uuid, text, text, uuid),
  public.legal_hold_release(uuid, uuid), public.privacy_anonymize_customer(uuid), public.retention_policy_register(text, integer, integer, boolean), public.retention_policy_approve(uuid, uuid, text),
  public.retention_policy_disable(uuid), public.retention_preview_onboarding_events(integer), public.retention_execute_onboarding_events(uuid, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.privacy_request_submit(uuid, text, text), public.privacy_request_advance(uuid, text, uuid, text), public.privacy_request_record_verification(uuid, text, text, uuid),
  public.privacy_request_approve(uuid, uuid, text, boolean, boolean, boolean), public.privacy_request_reject(uuid, uuid, text, text), public.legal_hold_place(uuid, uuid, text, text, uuid),
  public.legal_hold_release(uuid, uuid), public.privacy_anonymize_customer(uuid), public.retention_policy_register(text, integer, integer, boolean), public.retention_policy_approve(uuid, uuid, text),
  public.retention_policy_disable(uuid), public.retention_preview_onboarding_events(integer), public.retention_execute_onboarding_events(uuid, integer) TO customer_privacy_operator;--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('d2f.schema_create_granted', true) = 'on' THEN REVOKE CREATE ON SCHEMA public FROM customer_privacy_owner; END IF;
  IF current_setting('d2f.membership_granted', true) = 'on' THEN REVOKE customer_privacy_owner FROM CURRENT_USER; END IF;
  IF current_setting('d2f.erasure_owner_membership_granted', true) = 'on' THEN REVOKE onboarding_erasure_owner FROM CURRENT_USER; END IF;
  PERFORM set_config('d2f.schema_create_granted', '', false);
  PERFORM set_config('d2f.membership_granted', '', false);
  PERFORM set_config('d2f.erasure_owner_membership_granted', '', false);
END $$;
