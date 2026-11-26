CREATE TABLE "drop_fulfilment_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"parameters" jsonb NOT NULL,
	"parameters_hash" text NOT NULL,
	"approval_state" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_fulfilment_policies_version_uq" UNIQUE("policy_key","version"),
	CONSTRAINT "drop_fulfilment_policies_state" CHECK ("drop_fulfilment_policies"."approval_state" IN ('draft','approved','retired')),
	CONSTRAINT "drop_fulfilment_policies_hash" CHECK ("drop_fulfilment_policies"."parameters_hash" ~ '^[0-9a-f]{64}$' AND "drop_fulfilment_policies"."version" >= 1),
	CONSTRAINT "drop_fulfilment_policies_params" CHECK (jsonb_typeof("drop_fulfilment_policies"."parameters") = 'object' AND "drop_fulfilment_policies"."parameters"->>'collectionVerification' IN ('staff_confirmation','collection_code')
      AND (NOT ("drop_fulfilment_policies"."parameters" ? 'escalateAfterHours') OR (jsonb_typeof("drop_fulfilment_policies"."parameters"->'escalateAfterHours') = 'number' AND ("drop_fulfilment_policies"."parameters"->>'escalateAfterHours')::numeric > 0))),
	CONSTRAINT "drop_fulfilment_policies_approval_shape" CHECK (("drop_fulfilment_policies"."approval_state" = 'draft' AND "drop_fulfilment_policies"."approved_by_user_id" IS NULL AND "drop_fulfilment_policies"."approved_at" IS NULL AND "drop_fulfilment_policies"."retired_at" IS NULL)
      OR ("drop_fulfilment_policies"."approval_state" = 'approved' AND "drop_fulfilment_policies"."approved_by_user_id" IS NOT NULL AND "drop_fulfilment_policies"."approved_by_user_id" <> "drop_fulfilment_policies"."created_by_user_id" AND "drop_fulfilment_policies"."approved_at" IS NOT NULL AND "drop_fulfilment_policies"."retired_at" IS NULL)
      OR ("drop_fulfilment_policies"."approval_state" = 'retired' AND "drop_fulfilment_policies"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sponsor_application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"eligibility_assessment" jsonb NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"status_reason" text,
	"reviewer_user_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sponsor_applications_status" CHECK ("sponsor_applications"."status" IN ('submitted','under_review','approved','rejected','withdrawn','suspended','revoked')),
	CONSTRAINT "sponsor_applications_statement" CHECK (char_length("sponsor_applications"."statement") BETWEEN 1 AND 2000),
	CONSTRAINT "sponsor_applications_synthetic" CHECK ("sponsor_applications"."synthetic" = true)
);
--> statement-breakpoint
ALTER TABLE "drop_fulfilment_policies" ADD CONSTRAINT "drop_fulfilment_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_fulfilment_policies" ADD CONSTRAINT "drop_fulfilment_policies_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_application_events" ADD CONSTRAINT "sponsor_application_events_application_id_sponsor_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."sponsor_applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_application_events" ADD CONSTRAINT "sponsor_application_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_applications" ADD CONSTRAINT "sponsor_applications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_applications" ADD CONSTRAINT "sponsor_applications_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_applications" ADD CONSTRAINT "sponsor_applications_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_applications" ADD CONSTRAINT "sponsor_applications_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drop_fulfilment_policies_one_approved_uq" ON "drop_fulfilment_policies" USING btree ((true)) WHERE "drop_fulfilment_policies"."approval_state" = 'approved';--> statement-breakpoint
CREATE INDEX "sponsor_application_events_app_idx" ON "sponsor_application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsor_applications_one_live_uq" ON "sponsor_applications" USING btree ("business_id") WHERE "sponsor_applications"."status" IN ('submitted','under_review','approved','suspended');--> statement-breakpoint
CREATE INDEX "sponsor_applications_status_idx" ON "sponsor_applications" USING btree ("status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sponsor_applications_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE is_admin boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SPONSOR_APPLICATION_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' OR NEW.reviewer_user_id IS NOT NULL OR NEW.decided_by_user_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'SPONSOR_APPLICATION_NOT_ALLOWED (an application starts as submitted without review)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR NEW.submitted_by_user_id <> OLD.submitted_by_user_id OR NEW.statement <> OLD.statement OR NEW.eligibility_assessment <> OLD.eligibility_assessment
     OR NEW.synthetic <> OLD.synthetic OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SPONSOR_APPLICATION_IMMUTABLE (identity and submitted content)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = NEW.status THEN RAISE EXCEPTION 'SPONSOR_APPLICATION_IMMUTABLE (only status transitions are allowed)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.status IN ('under_review','approved','rejected','suspended','revoked') THEN
    -- every reviewing decision is by a platform administrator who did not submit the application
    SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = COALESCE(NEW.decided_by_user_id, NEW.reviewer_user_id) AND u.platform_role = 'admin') INTO is_admin;
    IF NOT is_admin OR COALESCE(NEW.decided_by_user_id, NEW.reviewer_user_id) = OLD.submitted_by_user_id THEN
      RAISE EXCEPTION 'SPONSOR_APPLICATION_SEPARATION_OF_DUTIES (an independent platform reviewer is required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF (OLD.status = 'submitted' AND NEW.status = 'under_review') THEN
    IF NEW.reviewer_user_id IS NULL OR NEW.decided_by_user_id IS NOT NULL THEN RAISE EXCEPTION 'SPONSOR_APPLICATION_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF (OLD.status = 'under_review' AND NEW.status IN ('approved','rejected')) THEN
    IF NEW.decided_by_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.decided_at IS NULL
       OR (NEW.status = 'rejected' AND (NEW.status_reason IS NULL OR char_length(NEW.status_reason) < 10)) THEN
      RAISE EXCEPTION 'SPONSOR_APPLICATION_IMMUTABLE (the assigned reviewer decides; a rejection needs a reason)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF (OLD.status = 'approved' AND NEW.status = 'suspended') OR (OLD.status = 'suspended' AND NEW.status = 'approved') OR (OLD.status IN ('approved','suspended') AND NEW.status = 'revoked') THEN
    IF NEW.status_reason IS NULL OR char_length(NEW.status_reason) < 10 OR NEW.decided_by_user_id IS NULL THEN
      RAISE EXCEPTION 'SPONSOR_APPLICATION_REASON_REQUIRED (a reason of at least 10 characters and the acting administrator are required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF (OLD.status IN ('submitted','under_review') AND NEW.status = 'withdrawn') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'SPONSOR_APPLICATION_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sponsor_application_events_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SPONSOR_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_fulfilment_policy_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FULFILMENT_POLICY_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_state <> 'draft' THEN RAISE EXCEPTION 'FULFILMENT_POLICY_IMMUTABLE (a policy starts as a draft)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.policy_key <> OLD.policy_key OR NEW.version <> OLD.version OR NEW.parameters <> OLD.parameters OR NEW.parameters_hash <> OLD.parameters_hash
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FULFILMENT_POLICY_IMMUTABLE (a policy version is never edited; publish a new version)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.approval_state = 'draft' AND NEW.approval_state = 'approved' THEN RETURN NEW; END IF;
  IF OLD.approval_state IN ('draft','approved') AND NEW.approval_state = 'retired' AND NEW.approved_by_user_id IS NOT DISTINCT FROM OLD.approved_by_user_id AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'FULFILMENT_POLICY_TRANSITION_NOT_ALLOWED (% -> %)', OLD.approval_state, NEW.approval_state USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_sponsorships_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE ok boolean := false; v_sponsorship uuid; v_qty integer; latest integer; chosen integer; has_inv boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.approved_version_id IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_NOT_ALLOWED (starts as a draft without review)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.key <> OLD.key OR NEW.business_id <> OLD.business_id OR NEW.synthetic <> OLD.synthetic OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = NEW.status THEN
    IF NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  ok := (OLD.status = 'draft' AND NEW.status IN ('submitted','cancelled'))
     OR (OLD.status = 'submitted' AND NEW.status IN ('under_review','cancelled'))
     OR (OLD.status = 'under_review' AND NEW.status IN ('approved','draft','cancelled'))
     OR (OLD.status = 'approved' AND NEW.status IN ('scheduled','suspended','cancelled'))
     OR (OLD.status = 'scheduled' AND NEW.status IN ('available','suspended','cancelled'))
     OR (OLD.status = 'available' AND NEW.status IN ('suspended','cancelled','expired'))
     OR (OLD.status = 'suspended' AND NEW.status IN ('available','cancelled'));
  IF NOT ok THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.status IN ('draft','suspended','cancelled') AND NEW.status_reason IS NULL THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_REASON_REQUIRED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'approved' THEN
    -- separation of duties: a reviewer who is not the creator, approving the LATEST version of this sponsorship
    IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id = OLD.created_by_user_id OR NEW.approved_version_id IS NULL THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_REVIEW_REQUIRED (an independent reviewer and the approved version are required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT max(version) INTO latest FROM drop_sponsorship_versions WHERE sponsorship_id = OLD.id;
    SELECT version INTO chosen FROM drop_sponsorship_versions WHERE id = NEW.approved_version_id AND sponsorship_id = OLD.id;
    IF chosen IS NULL OR chosen <> latest THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_REVIEW_REQUIRED (approve the latest version of this sponsorship)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
    IF NOT (NEW.status = 'draft') THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  END IF;
  IF NEW.status = 'draft' AND (NEW.approved_version_id IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (a returned draft clears the review)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('scheduled','available') THEN
    SELECT EXISTS (SELECT 1 FROM drop_inventory WHERE sponsorship_id = OLD.id) INTO has_inv;
    IF NEW.approved_version_id IS NULL OR NOT has_inv THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_NOT_READY (approved version and inventory are required)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NOT EXISTS (SELECT 1 FROM sponsor_applications sa WHERE sa.business_id = OLD.business_id AND sa.status = 'approved') THEN
      RAISE EXCEPTION 'DROP_SPONSOR_NOT_APPROVED (the business needs an approved, not suspended or revoked, sponsor application)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_reservations_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE s_status text; w_end timestamptz; n integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DROP_RESERVATION_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT s.status, v.collection_window_end INTO s_status, w_end FROM drop_sponsorships s JOIN drop_sponsorship_versions v ON v.id = s.approved_version_id WHERE s.id = NEW.sponsorship_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' OR s_status IS DISTINCT FROM 'available' OR NEW.hold_expires_at <= now()
       OR NOT EXISTS (SELECT 1 FROM sponsor_applications sa JOIN drop_sponsorships ds ON ds.business_id = sa.business_id WHERE ds.id = NEW.sponsorship_id AND sa.status = 'approved') THEN
      RAISE EXCEPTION 'DROP_RESERVATION_NOT_ALLOWED (needs an available sponsorship of an approved sponsor and a hold that expires in the future)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    UPDATE drop_inventory SET reserved = reserved + 1
      WHERE sponsorship_id = NEW.sponsorship_id AND reserved + allocated + collected + expired < total_quantity;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'DROP_INVENTORY_EXHAUSTED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.sponsorship_id <> OLD.sponsorship_id OR NEW.customer_id <> OLD.customer_id OR NEW.hold_expires_at <> OLD.hold_expires_at OR NEW.eligibility_evidence <> OLD.eligibility_evidence
     OR NEW.synthetic <> OLD.synthetic OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'DROP_RESERVATION_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'allocated' THEN
    IF s_status IS DISTINCT FROM 'available' OR OLD.hold_expires_at <= now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_ALLOWED (sponsorship not available or the hold expired)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET reserved = reserved - 1, allocated = allocated + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'released' THEN
    UPDATE drop_inventory SET reserved = reserved - 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'expired' THEN
    IF OLD.hold_expires_at > now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_EXPIRED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET reserved = reserved - 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'allocated' AND NEW.status = 'collected' THEN
    UPDATE drop_inventory SET allocated = allocated - 1, collected = collected + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'allocated' AND NEW.status = 'expired' THEN
    IF w_end > now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_EXPIRED (collection window still open)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET allocated = allocated - 1, expired = expired + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = NEW.status THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'DROP_RESERVATION_TRANSITION_NOT_ALLOWED (% -> %); an allocated unit is never silently withdrawn', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('released') AND NEW.status_reason IS NULL THEN RAISE EXCEPTION 'DROP_RESERVATION_REASON_REQUIRED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sponsor_applications_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sponsor_applications FOR EACH ROW EXECUTE FUNCTION sponsor_applications_guard();
--> statement-breakpoint
CREATE TRIGGER sponsor_applications_no_truncate BEFORE TRUNCATE ON sponsor_applications FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER sponsor_application_events_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON sponsor_application_events FOR EACH ROW EXECUTE FUNCTION sponsor_application_events_guard();
--> statement-breakpoint
CREATE TRIGGER sponsor_application_events_no_truncate BEFORE TRUNCATE ON sponsor_application_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER drop_fulfilment_policy_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON drop_fulfilment_policies FOR EACH ROW EXECUTE FUNCTION drop_fulfilment_policy_guard();
--> statement-breakpoint
CREATE TRIGGER drop_fulfilment_policy_no_truncate BEFORE TRUNCATE ON drop_fulfilment_policies FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE sponsor_applications ENABLE ALWAYS TRIGGER sponsor_applications_guard_trg;
--> statement-breakpoint
ALTER TABLE sponsor_applications ENABLE ALWAYS TRIGGER sponsor_applications_no_truncate;
--> statement-breakpoint
ALTER TABLE sponsor_application_events ENABLE ALWAYS TRIGGER sponsor_application_events_guard_trg;
--> statement-breakpoint
ALTER TABLE sponsor_application_events ENABLE ALWAYS TRIGGER sponsor_application_events_no_truncate;
--> statement-breakpoint
ALTER TABLE drop_fulfilment_policies ENABLE ALWAYS TRIGGER drop_fulfilment_policy_guard_trg;
--> statement-breakpoint
ALTER TABLE drop_fulfilment_policies ENABLE ALWAYS TRIGGER drop_fulfilment_policy_no_truncate;
