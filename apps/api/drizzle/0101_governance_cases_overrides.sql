CREATE TABLE "governance_case_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_case_evidence_kind" CHECK ("governance_case_evidence"."kind" IN ('note','reference')),
	CONSTRAINT "governance_case_evidence_body" CHECK (char_length("governance_case_evidence"."body") BETWEEN 1 AND 2000 AND "governance_case_evidence"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "governance_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"campaign_version_id" uuid,
	"sponsorship_id" uuid,
	"classification" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"reviewer_user_id" uuid,
	"related_case_id" uuid,
	"escalation_reason" text,
	"decision" text,
	"decision_reason" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_cases_kind" CHECK ("governance_cases"."kind" IN ('fraud','dispute')),
	CONSTRAINT "governance_cases_subject_type" CHECK ("governance_cases"."subject_type" IN ('shuffle_campaign_version','shuffle_entry','shuffle_selection','drop_sponsorship','drop_reservation')),
	CONSTRAINT "governance_cases_classification" CHECK ("governance_cases"."classification" IN ('suspected_duplicate_participation','suspected_fabricated_evidence','allocation_dispute','collection_dispute','other')),
	CONSTRAINT "governance_cases_status" CHECK ("governance_cases"."status" IN ('open','escalated','under_review','decided','closed')),
	CONSTRAINT "governance_cases_family" CHECK (("governance_cases"."subject_type" LIKE 'shuffle_%' AND "governance_cases"."campaign_version_id" IS NOT NULL AND "governance_cases"."sponsorship_id" IS NULL) OR ("governance_cases"."subject_type" LIKE 'drop_%' AND "governance_cases"."sponsorship_id" IS NOT NULL AND "governance_cases"."campaign_version_id" IS NULL)),
	CONSTRAINT "governance_cases_text" CHECK (char_length("governance_cases"."summary") BETWEEN 1 AND 1000),
	CONSTRAINT "governance_cases_decision_shape" CHECK (("governance_cases"."decision" IS NULL AND "governance_cases"."decided_by_user_id" IS NULL AND "governance_cases"."decided_at" IS NULL AND "governance_cases"."decision_reason" IS NULL) OR ("governance_cases"."decision" IN ('upheld','overturned','no_action') AND "governance_cases"."decided_by_user_id" IS NOT NULL AND "governance_cases"."decided_at" IS NOT NULL AND char_length("governance_cases"."decision_reason") >= 10)),
	CONSTRAINT "governance_cases_synthetic" CHECK ("governance_cases"."synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "governance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"event" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_events_seq_uq" UNIQUE("case_id","seq"),
	CONSTRAINT "governance_events_hash" CHECK ("governance_events"."hash" ~ '^[0-9a-f]{64}$' AND ("governance_events"."prev_hash" IS NULL OR "governance_events"."prev_hash" ~ '^[0-9a-f]{64}$') AND "governance_events"."seq" >= 1 AND (("governance_events"."seq" = 1) = ("governance_events"."prev_hash" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "governance_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_operators_role" CHECK ("governance_operators"."role" IN ('fraud_investigator','dispute_resolver'))
);
--> statement-breakpoint
CREATE TABLE "governance_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" uuid NOT NULL,
	"justification" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_overrides_scope" CHECK ("governance_overrides"."scope" IN ('cancel_entry_before_selection','release_reserved_hold')),
	CONSTRAINT "governance_overrides_status" CHECK ("governance_overrides"."status" IN ('requested','approved','executed','rejected','cancelled','expired')),
	CONSTRAINT "governance_overrides_justification" CHECK (char_length("governance_overrides"."justification") BETWEEN 10 AND 1000 AND "governance_overrides"."evidence_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "governance_overrides_two_person" CHECK ("governance_overrides"."approved_by_user_id" IS NULL OR "governance_overrides"."approved_by_user_id" <> "governance_overrides"."requested_by_user_id"),
	CONSTRAINT "governance_overrides_approval_shape" CHECK (("governance_overrides"."status" IN ('approved','executed')) = ("governance_overrides"."approved_by_user_id" IS NOT NULL) OR "governance_overrides"."status" IN ('expired','cancelled')),
	CONSTRAINT "governance_overrides_synthetic" CHECK ("governance_overrides"."synthetic" = true)
);
--> statement-breakpoint
ALTER TABLE "governance_case_evidence" ADD CONSTRAINT "governance_case_evidence_case_id_governance_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."governance_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_case_evidence" ADD CONSTRAINT "governance_case_evidence_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_cases" ADD CONSTRAINT "governance_cases_campaign_version_id_shuffle_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."shuffle_campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_cases" ADD CONSTRAINT "governance_cases_sponsorship_id_drop_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "public"."drop_sponsorships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_cases" ADD CONSTRAINT "governance_cases_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_cases" ADD CONSTRAINT "governance_cases_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_cases" ADD CONSTRAINT "governance_cases_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_events" ADD CONSTRAINT "governance_events_case_id_governance_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."governance_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_events" ADD CONSTRAINT "governance_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operators" ADD CONSTRAINT "governance_operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_overrides" ADD CONSTRAINT "governance_overrides_case_id_governance_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."governance_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_overrides" ADD CONSTRAINT "governance_overrides_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_overrides" ADD CONSTRAINT "governance_overrides_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_case_evidence_case_idx" ON "governance_case_evidence" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "governance_cases_subject_idx" ON "governance_cases" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "governance_cases_status_idx" ON "governance_cases" USING btree ("status","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_operators_user_role_uq" ON "governance_operators" USING btree ("user_id","role");--> statement-breakpoint
CREATE INDEX "governance_overrides_case_idx" ON "governance_overrides" USING btree ("case_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_overrides_open_target_uq" ON "governance_overrides" USING btree ("scope","target_id") WHERE "governance_overrides"."status" IN ('requested','approved');--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'GOVERNANCE_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_has_role(p_user uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM governance_operators WHERE user_id = p_user AND role = p_role AND active) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_cases_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE subject_ok boolean := false; creator uuid; need_role text; rel governance_cases%ROWTYPE;
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
  IF OLD.status = 'open' AND NEW.status = 'escalated' THEN
    IF NEW.escalation_reason IS NULL OR char_length(NEW.escalation_reason) < 10 THEN RAISE EXCEPTION 'GOVERNANCE_REASON_REQUIRED (escalation)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.reviewer_user_id IS NOT NULL OR NEW.decision IS NOT NULL THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('open','escalated') AND NEW.status = 'under_review' THEN
    IF NEW.reviewer_user_id IS NULL OR NEW.reviewer_user_id = OLD.opened_by_user_id OR NOT governance_has_role(NEW.reviewer_user_id, need_role) THEN
      RAISE EXCEPTION 'GOVERNANCE_REVIEWER_NOT_ALLOWED (an assigned %, who did not open the case, is required)', need_role USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.decision IS NOT NULL OR NEW.escalation_reason IS DISTINCT FROM OLD.escalation_reason THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'under_review' AND NEW.status = 'decided' THEN
    IF NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.decided_by_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.decided_by_user_id = OLD.opened_by_user_id
       OR NOT governance_has_role(NEW.decided_by_user_id, need_role) THEN
      RAISE EXCEPTION 'GOVERNANCE_DECIDER_NOT_ALLOWED (the assigned reviewer must decide, must not have opened the case and must hold the operator role)' USING ERRCODE = 'integrity_constraint_violation';
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
CREATE OR REPLACE FUNCTION governance_evidence_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE s text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'GOVERNANCE_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT status INTO s FROM governance_cases WHERE id = NEW.case_id;
  IF s IS NULL OR s = 'closed' THEN RAISE EXCEPTION 'GOVERNANCE_EVIDENCE_NOT_ALLOWED (the case is closed)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_events_chain() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE last_seq integer; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('governance_chain:' || NEW.case_id::text, 0));
  SELECT seq, hash INTO last_seq, last_hash FROM governance_events WHERE case_id = NEW.case_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(last_seq, 0) + 1 OR NEW.prev_hash IS DISTINCT FROM last_hash THEN
    RAISE EXCEPTION 'GOVERNANCE_CHAIN_BROKEN (sequence or previous hash does not extend the chain)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION governance_overrides_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE c_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO c_status FROM governance_cases WHERE id = NEW.case_id;
    IF NEW.status <> 'requested' OR NEW.approved_by_user_id IS NOT NULL OR NEW.expires_at <= now() OR c_status IS NULL OR c_status NOT IN ('under_review','decided')
       OR NOT governance_has_role(NEW.requested_by_user_id, 'fraud_investigator') THEN
      RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_NOT_ALLOWED (needs a case under review or decided, an assigned fraud investigator as requester and a future expiry)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id OR NEW.scope <> OLD.scope OR NEW.target_id <> OLD.target_id OR NEW.justification <> OLD.justification OR NEW.evidence_hash <> OLD.evidence_hash
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.expires_at <> OLD.expires_at OR NEW.synthetic <> OLD.synthetic OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'requested' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_by_user_id = OLD.requested_by_user_id OR NOT governance_has_role(NEW.approved_by_user_id, 'dispute_resolver') OR OLD.expires_at <= now() THEN
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
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'GOVERNANCE_OPERATOR_IMMUTABLE (only the active flag can change)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER governance_cases_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON governance_cases FOR EACH ROW EXECUTE FUNCTION governance_cases_guard();
--> statement-breakpoint
CREATE TRIGGER governance_evidence_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON governance_case_evidence FOR EACH ROW EXECUTE FUNCTION governance_evidence_guard();
--> statement-breakpoint
CREATE TRIGGER governance_events_chain_trg BEFORE INSERT ON governance_events FOR EACH ROW EXECUTE FUNCTION governance_events_chain();
--> statement-breakpoint
CREATE TRIGGER governance_events_append_only_trg BEFORE UPDATE OR DELETE ON governance_events FOR EACH ROW EXECUTE FUNCTION governance_append_only();
--> statement-breakpoint
CREATE TRIGGER governance_overrides_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON governance_overrides FOR EACH ROW EXECUTE FUNCTION governance_overrides_guard();
--> statement-breakpoint
CREATE TRIGGER governance_operators_guard_trg BEFORE UPDATE OR DELETE ON governance_operators FOR EACH ROW EXECUTE FUNCTION governance_operators_guard();
--> statement-breakpoint
CREATE TRIGGER governance_cases_no_truncate BEFORE TRUNCATE ON governance_cases FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER governance_evidence_no_truncate BEFORE TRUNCATE ON governance_case_evidence FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER governance_events_no_truncate BEFORE TRUNCATE ON governance_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER governance_overrides_no_truncate BEFORE TRUNCATE ON governance_overrides FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER governance_operators_no_truncate BEFORE TRUNCATE ON governance_operators FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE governance_cases ENABLE ALWAYS TRIGGER governance_cases_guard_trg;
--> statement-breakpoint
ALTER TABLE governance_case_evidence ENABLE ALWAYS TRIGGER governance_evidence_guard_trg;
--> statement-breakpoint
ALTER TABLE governance_events ENABLE ALWAYS TRIGGER governance_events_chain_trg;
--> statement-breakpoint
ALTER TABLE governance_events ENABLE ALWAYS TRIGGER governance_events_append_only_trg;
--> statement-breakpoint
ALTER TABLE governance_overrides ENABLE ALWAYS TRIGGER governance_overrides_guard_trg;
--> statement-breakpoint
ALTER TABLE governance_operators ENABLE ALWAYS TRIGGER governance_operators_guard_trg;
--> statement-breakpoint
ALTER TABLE governance_cases ENABLE ALWAYS TRIGGER governance_cases_no_truncate;
--> statement-breakpoint
ALTER TABLE governance_case_evidence ENABLE ALWAYS TRIGGER governance_evidence_no_truncate;
--> statement-breakpoint
ALTER TABLE governance_events ENABLE ALWAYS TRIGGER governance_events_no_truncate;
--> statement-breakpoint
ALTER TABLE governance_overrides ENABLE ALWAYS TRIGGER governance_overrides_no_truncate;
--> statement-breakpoint
ALTER TABLE governance_operators ENABLE ALWAYS TRIGGER governance_operators_no_truncate;
