CREATE TABLE "b2b_participations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"terms_version_id" uuid NOT NULL,
	"terms_digest" text NOT NULL,
	"accepted_by_user_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"enrolled_by_user_id" uuid NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_participations_status_check" CHECK ("b2b_participations"."status" IN ('active','suspended')),
	CONSTRAINT "b2b_participations_digest_check" CHECK ("b2b_participations"."terms_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "b2b_participations_suspension_check" CHECK (("b2b_participations"."status" = 'suspended') = ("b2b_participations"."suspended_at" IS NOT NULL AND "b2b_participations"."suspended_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "b2b_terms_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"terms_digest" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"effective_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_terms_versions_version_unique" UNIQUE("version"),
	CONSTRAINT "b2b_terms_versions_digest_check" CHECK ("b2b_terms_versions"."terms_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "b2b_terms_versions_state_check" CHECK ("b2b_terms_versions"."state" IN ('draft','active','retired')),
	CONSTRAINT "b2b_terms_versions_active_effective_check" CHECK ("b2b_terms_versions"."state" <> 'active' OR "b2b_terms_versions"."effective_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_terms_version_id_b2b_terms_versions_id_fk" FOREIGN KEY ("terms_version_id") REFERENCES "public"."b2b_terms_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_enrolled_by_user_id_users_id_fk" FOREIGN KEY ("enrolled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_suspended_by_user_id_users_id_fk" FOREIGN KEY ("suspended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_participations_business_key" ON "b2b_participations" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_terms_one_active_idx" ON "b2b_terms_versions" USING btree ("state") WHERE "b2b_terms_versions"."state" = 'active';--> statement-breakpoint
-- S9-A1 guards (SPLIT 09, owner ruling S9-D1). Enforced in the database so a direct SQL session cannot bypass them.
CREATE OR REPLACE FUNCTION b2b_terms_version_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'B2B_TERMS_DELETE_DENIED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.terms_digest IS DISTINCT FROM OLD.terms_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'B2B_TERMS_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'draft' AND NEW.state = 'active') OR (OLD.state = 'active' AND NEW.state = 'retired')) THEN
    RAISE EXCEPTION 'B2B_TERMS_STATE_TRANSITION_DENIED (% -> %)', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER b2b_terms_version_guard_trg BEFORE UPDATE OR DELETE ON b2b_terms_versions FOR EACH ROW EXECUTE FUNCTION b2b_terms_version_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_participation_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE terms_row b2b_terms_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'B2B_PARTICIPATION_DELETE_DENIED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO terms_row FROM b2b_terms_versions WHERE id = NEW.terms_version_id;
    IF NOT FOUND OR terms_row.state <> 'active' OR terms_row.terms_digest <> NEW.terms_digest THEN
      RAISE EXCEPTION 'B2B_PARTICIPATION_REQUIRES_ACTIVE_TERMS' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'B2B_PARTICIPATION_MUST_START_ACTIVE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.accepted_by_user_id = NEW.enrolled_by_user_id THEN
      RAISE EXCEPTION 'B2B_PARTICIPATION_SEPARATE_ACCEPTOR_REQUIRED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.terms_version_id IS DISTINCT FROM OLD.terms_version_id OR NEW.terms_digest IS DISTINCT FROM OLD.terms_digest
     OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
     OR NEW.enrolled_by_user_id IS DISTINCT FROM OLD.enrolled_by_user_id OR NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'B2B_PARTICIPATION_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status = 'suspended') OR (OLD.status = 'suspended' AND NEW.status = 'active')) THEN
    RAISE EXCEPTION 'B2B_PARTICIPATION_TRANSITION_DENIED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER b2b_participation_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON b2b_participations FOR EACH ROW EXECUTE FUNCTION b2b_participation_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_truncate_denied() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'B2B_TRUNCATE_DENIED (%)', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER b2b_terms_versions_no_truncate BEFORE TRUNCATE ON b2b_terms_versions FOR EACH STATEMENT EXECUTE FUNCTION b2b_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER b2b_participations_no_truncate BEFORE TRUNCATE ON b2b_participations FOR EACH STATEMENT EXECUTE FUNCTION b2b_truncate_denied();
--> statement-breakpoint
ALTER TABLE b2b_terms_versions ENABLE ALWAYS TRIGGER b2b_terms_version_guard_trg;
--> statement-breakpoint
ALTER TABLE b2b_terms_versions ENABLE ALWAYS TRIGGER b2b_terms_versions_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_participations ENABLE ALWAYS TRIGGER b2b_participation_guard_trg;
--> statement-breakpoint
ALTER TABLE b2b_participations ENABLE ALWAYS TRIGGER b2b_participations_no_truncate;
