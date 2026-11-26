CREATE TABLE "governance_decision_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"subject_family" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"parameters_hash" text NOT NULL,
	"approval_state" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_decision_policies_version_uq" UNIQUE("policy_key","version"),
	CONSTRAINT "governance_decision_policies_kind" CHECK ("governance_decision_policies"."kind" IN ('fraud','dispute','override')),
	CONSTRAINT "governance_decision_policies_family" CHECK ("governance_decision_policies"."subject_family" IN ('shuffle','drops')),
	CONSTRAINT "governance_decision_policies_state" CHECK ("governance_decision_policies"."approval_state" IN ('draft','approved','retired')),
	CONSTRAINT "governance_decision_policies_hash" CHECK ("governance_decision_policies"."parameters_hash" ~ '^[0-9a-f]{64}$' AND "governance_decision_policies"."version" >= 1),
	CONSTRAINT "governance_decision_policies_params" CHECK (jsonb_typeof("governance_decision_policies"."parameters") = 'object' AND (
      ("governance_decision_policies"."kind" IN ('fraud','dispute') AND jsonb_typeof("governance_decision_policies"."parameters"->'allowedDecisions') = 'array' AND jsonb_typeof("governance_decision_policies"."parameters"->'minEvidenceItems') = 'number')
      OR ("governance_decision_policies"."kind" = 'override' AND jsonb_typeof("governance_decision_policies"."parameters"->'allowedScopes') = 'array'))),
	CONSTRAINT "governance_decision_policies_approval_shape" CHECK (("governance_decision_policies"."approval_state" = 'draft' AND "governance_decision_policies"."approved_by_user_id" IS NULL AND "governance_decision_policies"."approved_at" IS NULL AND "governance_decision_policies"."retired_at" IS NULL)
      OR ("governance_decision_policies"."approval_state" = 'approved' AND "governance_decision_policies"."approved_by_user_id" IS NOT NULL AND "governance_decision_policies"."approved_by_user_id" <> "governance_decision_policies"."created_by_user_id" AND "governance_decision_policies"."approved_at" IS NOT NULL AND "governance_decision_policies"."retired_at" IS NULL)
      OR ("governance_decision_policies"."approval_state" = 'retired' AND "governance_decision_policies"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "governance_operator_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_operator_events_type" CHECK ("governance_operator_events"."event_type" IN ('assigned','revoked'))
);
--> statement-breakpoint
DROP INDEX "governance_operators_user_role_uq";--> statement-breakpoint
ALTER TABLE "governance_cases" ADD COLUMN "decision_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD COLUMN "scope" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD COLUMN "assigned_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD COLUMN "revoked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD COLUMN "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "governance_decision_policies" ADD CONSTRAINT "governance_decision_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_decision_policies" ADD CONSTRAINT "governance_decision_policies_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operator_events" ADD CONSTRAINT "governance_operator_events_operator_id_governance_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."governance_operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operator_events" ADD CONSTRAINT "governance_operator_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_decision_policies_one_approved_uq" ON "governance_decision_policies" USING btree ("kind","subject_family") WHERE "governance_decision_policies"."approval_state" = 'approved';--> statement-breakpoint
CREATE INDEX "governance_operator_events_operator_idx" ON "governance_operator_events" USING btree ("operator_id","created_at");--> statement-breakpoint
ALTER TABLE "governance_cases" ADD CONSTRAINT "governance_cases_decision_policy_id_governance_decision_policies_id_fk" FOREIGN KEY ("decision_policy_id") REFERENCES "public"."governance_decision_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD CONSTRAINT "governance_operators_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD CONSTRAINT "governance_operators_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_operators_current_uq" ON "governance_operators" USING btree ("user_id","role") WHERE "governance_operators"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD CONSTRAINT "governance_operators_scope" CHECK ("governance_operators"."scope" IN ('shuffle','drops','both'));--> statement-breakpoint
ALTER TABLE "governance_operators" ADD CONSTRAINT "governance_operators_window" CHECK ("governance_operators"."expires_at" IS NULL OR "governance_operators"."expires_at" > "governance_operators"."valid_from");--> statement-breakpoint
ALTER TABLE "governance_operators" ADD CONSTRAINT "governance_operators_revocation_shape" CHECK (("governance_operators"."revoked_at" IS NULL AND "governance_operators"."revoked_by_user_id" IS NULL AND "governance_operators"."revocation_reason" IS NULL) OR ("governance_operators"."revoked_at" IS NOT NULL AND "governance_operators"."revoked_by_user_id" IS NOT NULL AND char_length("governance_operators"."revocation_reason") >= 10 AND "governance_operators"."active" = false));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_cases_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE subject_ok boolean := false; creator uuid; need_role text; rel governance_cases%ROWTYPE; fam text; pol governance_decision_policies%ROWTYPE; ev_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.reviewer_user_id IS NOT NULL OR NEW.decision IS NOT NULL OR NEW.escalation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'GOVERNANCE_CASE_NOT_ALLOWED (a case starts open and undecided)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    subject_ok := CASE NEW.subject_type
      WHEN 'shuffle_campaign_version' THEN NEW.subject_id = NEW.campaign_version_id
      WHEN 'shuffle_entry' THEN EXISTS (SELECT 1 FROM shuffle_entries WHERE id = NEW.subject_id AND campaign_version_id = NEW.campaign_version_id)
      WHEN 'shuffle_selection' THEN EXISTS (SELECT 1 FROM shuffle_selection_results WHERE id = NEW.subject_id AND campaign_version_id = NEW.campaign_version_id)
      WHEN 'drop_sponsorship' THEN NEW.subject_id = NEW.sponsorship_id
      WHEN 'drop_reservation' THEN EXISTS (SELECT 1 FROM drop_reservations WHERE id = NEW.subject_id AND sponsorship_id = NEW.sponsorship_id)
      ELSE false END;
    IF NOT subject_ok THEN RAISE EXCEPTION 'GOVERNANCE_CASE_SUBJECT_INVALID (the subject does not exist under the referenced campaign or sponsorship)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.related_case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM governance_cases WHERE id = NEW.related_case_id) THEN
      RAISE EXCEPTION 'GOVERNANCE_CASE_SUBJECT_INVALID (related case)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id OR NEW.campaign_version_id IS DISTINCT FROM OLD.campaign_version_id
     OR NEW.sponsorship_id IS DISTINCT FROM OLD.sponsorship_id OR NEW.classification <> OLD.classification OR NEW.summary <> OLD.summary OR NEW.opened_by_user_id <> OLD.opened_by_user_id
     OR NEW.related_case_id IS DISTINCT FROM OLD.related_case_id OR NEW.synthetic <> OLD.synthetic OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  need_role := CASE WHEN NEW.kind = 'fraud' THEN 'fraud_investigator' ELSE 'dispute_resolver' END;
  fam := CASE WHEN OLD.subject_type LIKE 'shuffle_%' THEN 'shuffle' ELSE 'drops' END;
  IF NEW.decision_policy_id IS DISTINCT FROM OLD.decision_policy_id AND NOT (OLD.status = 'under_review' AND NEW.status = 'decided') THEN
    RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (the decision policy is recorded only with the decision)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'escalated' THEN
    IF NEW.escalation_reason IS NULL OR char_length(NEW.escalation_reason) < 10 THEN RAISE EXCEPTION 'GOVERNANCE_REASON_REQUIRED (escalation)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.reviewer_user_id IS NOT NULL OR NEW.decision IS NOT NULL THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('open','escalated') AND NEW.status = 'under_review' THEN
    IF NEW.reviewer_user_id IS NULL OR NEW.reviewer_user_id = OLD.opened_by_user_id OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.reviewer_user_id AND go_.role = need_role AND go_.active AND go_.revoked_at IS NULL AND go_.valid_from <= now() AND (go_.expires_at IS NULL OR go_.expires_at > now()) AND go_.scope IN ('both', fam)) THEN
      RAISE EXCEPTION 'GOVERNANCE_REVIEWER_NOT_ALLOWED (an assigned %, who did not open the case, is required)', need_role USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.decision IS NOT NULL OR NEW.decision_policy_id IS NOT NULL OR NEW.escalation_reason IS DISTINCT FROM OLD.escalation_reason THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'under_review' AND NEW.status = 'decided' THEN
    IF NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.decided_by_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.decided_by_user_id = OLD.opened_by_user_id
       OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.decided_by_user_id AND go_.role = need_role AND go_.active AND go_.revoked_at IS NULL AND go_.valid_from <= now() AND (go_.expires_at IS NULL OR go_.expires_at > now()) AND go_.scope IN ('both', fam)) THEN
      RAISE EXCEPTION 'GOVERNANCE_DECIDER_NOT_ALLOWED (the assigned reviewer must decide, must not have opened the case and must hold the operator role)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT * INTO pol FROM governance_decision_policies WHERE id = NEW.decision_policy_id;
    IF pol.id IS NULL OR pol.approval_state <> 'approved' OR pol.kind <> OLD.kind OR pol.subject_family <> fam THEN
      RAISE EXCEPTION 'GOVERNANCE_POLICY_REQUIRED (an approved decision policy for this kind and subject family is required to decide)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT (pol.parameters->'allowedDecisions') ? NEW.decision THEN
      RAISE EXCEPTION 'GOVERNANCE_POLICY_VIOLATION (the decision is not allowed by the policy)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT count(*) INTO ev_count FROM governance_case_evidence WHERE case_id = OLD.id;
    IF ev_count < (pol.parameters->>'minEvidenceItems')::integer THEN
      RAISE EXCEPTION 'GOVERNANCE_POLICY_VIOLATION (the policy requires more evidence items than the case holds)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.subject_type LIKE 'shuffle_%' THEN
      SELECT c.created_by_user_id INTO creator FROM shuffle_campaign_versions v JOIN shuffle_campaigns c ON c.id = v.campaign_id WHERE v.id = OLD.campaign_version_id;
    ELSE
      SELECT created_by_user_id INTO creator FROM drop_sponsorships WHERE id = OLD.sponsorship_id;
    END IF;
    IF NEW.decided_by_user_id = creator THEN RAISE EXCEPTION 'GOVERNANCE_DECIDER_NOT_ALLOWED (an administrator who created the campaign or sponsorship cannot decide a case about it)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF OLD.related_case_id IS NOT NULL THEN
      SELECT * INTO rel FROM governance_cases WHERE id = OLD.related_case_id;
      IF NEW.decided_by_user_id IN (rel.reviewer_user_id, rel.decided_by_user_id) THEN RAISE EXCEPTION 'GOVERNANCE_DECIDER_NOT_ALLOWED (the fraud investigator and the dispute approver must be different people)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'decided' AND NEW.status = 'closed' THEN
    IF NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id THEN
      RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (a recorded decision is never rewritten)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'GOVERNANCE_CASE_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_overrides_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE c_status text; fam text; pol governance_decision_policies%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status, CASE WHEN subject_type LIKE 'shuffle_%' THEN 'shuffle' ELSE 'drops' END INTO c_status, fam FROM governance_cases WHERE id = NEW.case_id;
    SELECT * INTO pol FROM governance_decision_policies WHERE kind = 'override' AND subject_family = fam AND approval_state = 'approved';
    IF pol.id IS NULL OR NOT (pol.parameters->'allowedScopes') ? NEW.scope OR (pol.parameters ? 'maxExpirySeconds' AND NEW.expires_at > now() + make_interval(secs => (pol.parameters->>'maxExpirySeconds')::numeric)) THEN
      RAISE EXCEPTION 'GOVERNANCE_POLICY_REQUIRED (an approved override policy that allows this scope, and the requested expiry, is required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> 'requested' OR NEW.approved_by_user_id IS NOT NULL OR NEW.expires_at <= now() OR c_status IS NULL OR c_status NOT IN ('under_review','decided')
       OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.requested_by_user_id AND go_.role = 'fraud_investigator' AND go_.active AND go_.revoked_at IS NULL AND go_.valid_from <= now() AND (go_.expires_at IS NULL OR go_.expires_at > now()) AND go_.scope IN ('both', fam)) THEN
      RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_NOT_ALLOWED (needs a case under review or decided, an assigned fraud investigator as requester and a future expiry)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id OR NEW.scope <> OLD.scope OR NEW.target_id <> OLD.target_id OR NEW.justification <> OLD.justification OR NEW.evidence_hash <> OLD.evidence_hash
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.expires_at <> OLD.expires_at OR NEW.synthetic <> OLD.synthetic OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'requested' AND NEW.status = 'approved' THEN
    SELECT CASE WHEN subject_type LIKE 'shuffle_%' THEN 'shuffle' ELSE 'drops' END INTO fam FROM governance_cases WHERE id = OLD.case_id;
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_by_user_id = OLD.requested_by_user_id OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.approved_by_user_id AND go_.role = 'dispute_resolver' AND go_.active AND go_.revoked_at IS NULL AND go_.valid_from <= now() AND (go_.expires_at IS NULL OR go_.expires_at > now()) AND go_.scope IN ('both', fam)) OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'GOVERNANCE_APPROVAL_NOT_ALLOWED (a different assigned dispute resolver, before expiry, is required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'executed' THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id OR OLD.expires_at <= now() THEN RAISE EXCEPTION 'GOVERNANCE_APPROVAL_NOT_ALLOWED (expired or altered approval)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF (OLD.status = 'requested' AND NEW.status IN ('rejected','cancelled')) OR (OLD.status = 'approved' AND NEW.status = 'cancelled') THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id THEN RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (approver)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF OLD.status IN ('requested','approved') AND NEW.status = 'expired' AND OLD.expires_at <= now() THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id THEN RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (approver)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSE
    RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_operators_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_LEDGER_APPEND_ONLY (DELETE on governance_operators)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.assigned_by_user_id IS NULL OR NEW.assigned_by_user_id = NEW.user_id THEN
      RAISE EXCEPTION 'GOVERNANCE_OPERATOR_NOT_ALLOWED (an assignment is made by a different person and starts un-revoked)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role OR NEW.created_at <> OLD.created_at OR NEW.scope <> OLD.scope OR NEW.valid_from <> OLD.valid_from
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id THEN
    RAISE EXCEPTION 'GOVERNANCE_OPERATOR_IMMUTABLE (an assignment is never edited; only revoked)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'GOVERNANCE_OPERATOR_IMMUTABLE (a revoked assignment is final; a new assignment is a new row)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.revoked_at IS NULL OR NEW.active THEN RAISE EXCEPTION 'GOVERNANCE_OPERATOR_IMMUTABLE (the only change allowed is revocation with a reason)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_policy_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_POLICY_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_state <> 'draft' THEN RAISE EXCEPTION 'GOVERNANCE_POLICY_IMMUTABLE (a policy starts as a draft)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.policy_key <> OLD.policy_key OR NEW.version <> OLD.version OR NEW.kind <> OLD.kind OR NEW.subject_family <> OLD.subject_family OR NEW.parameters <> OLD.parameters
     OR NEW.parameters_hash <> OLD.parameters_hash OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'GOVERNANCE_POLICY_IMMUTABLE (a policy version is never edited; publish a new version)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.approval_state = 'draft' AND NEW.approval_state = 'approved' THEN RETURN NEW; END IF;
  IF OLD.approval_state IN ('draft','approved') AND NEW.approval_state = 'retired' AND NEW.approved_by_user_id IS NOT DISTINCT FROM OLD.approved_by_user_id AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'GOVERNANCE_POLICY_TRANSITION_NOT_ALLOWED (% -> %)', OLD.approval_state, NEW.approval_state USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_operator_events_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'GOVERNANCE_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS governance_operators_guard_trg ON governance_operators;
--> statement-breakpoint
CREATE TRIGGER governance_operators_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON governance_operators FOR EACH ROW EXECUTE FUNCTION governance_operators_guard();
--> statement-breakpoint
ALTER TABLE governance_operators ENABLE ALWAYS TRIGGER governance_operators_guard_trg;
--> statement-breakpoint
CREATE TRIGGER governance_policy_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON governance_decision_policies FOR EACH ROW EXECUTE FUNCTION governance_policy_guard();
--> statement-breakpoint
CREATE TRIGGER governance_policy_no_truncate BEFORE TRUNCATE ON governance_decision_policies FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER governance_operator_events_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON governance_operator_events FOR EACH ROW EXECUTE FUNCTION governance_operator_events_guard();
--> statement-breakpoint
CREATE TRIGGER governance_operator_events_no_truncate BEFORE TRUNCATE ON governance_operator_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE governance_decision_policies ENABLE ALWAYS TRIGGER governance_policy_guard_trg;
--> statement-breakpoint
ALTER TABLE governance_decision_policies ENABLE ALWAYS TRIGGER governance_policy_no_truncate;
--> statement-breakpoint
ALTER TABLE governance_operator_events ENABLE ALWAYS TRIGGER governance_operator_events_guard_trg;
--> statement-breakpoint
ALTER TABLE governance_operator_events ENABLE ALWAYS TRIGGER governance_operator_events_no_truncate;
