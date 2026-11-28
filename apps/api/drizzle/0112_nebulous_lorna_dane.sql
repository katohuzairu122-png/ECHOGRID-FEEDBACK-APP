CREATE TABLE "b2b_participation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participation_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_participation_events_type_valid" CHECK ("b2b_participation_events"."event_type" IN ('enrolled','suspended','reinstated','withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "b2b_participations" DROP CONSTRAINT "b2b_participations_status_check";--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD COLUMN "withdrawn_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "b2b_participation_events" ADD CONSTRAINT "b2b_participation_events_participation_id_b2b_participations_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."b2b_participations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_participation_events" ADD CONSTRAINT "b2b_participation_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_participation_events" ADD CONSTRAINT "b2b_participation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "b2b_participation_events_identity_idx" ON "b2b_participation_events" USING btree ("participation_id","created_at");--> statement-breakpoint
CREATE INDEX "b2b_participation_events_business_idx" ON "b2b_participation_events" USING btree ("business_id","created_at");--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_withdrawal_check" CHECK (("b2b_participations"."status" = 'withdrawn') = ("b2b_participations"."withdrawn_at" IS NOT NULL AND "b2b_participations"."withdrawn_by_user_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "b2b_participations" ADD CONSTRAINT "b2b_participations_status_check" CHECK ("b2b_participations"."status" IN ('active','suspended','withdrawn'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_participation_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE terms_row b2b_terms_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'B2B_PARTICIPATION_DELETE_DENIED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO terms_row FROM b2b_terms_versions WHERE id = NEW.terms_version_id;
    IF NOT FOUND OR terms_row.state <> 'active' OR terms_row.terms_digest <> NEW.terms_digest THEN RAISE EXCEPTION 'B2B_PARTICIPATION_REQUIRES_ACTIVE_TERMS' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'B2B_PARTICIPATION_MUST_START_ACTIVE' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.accepted_by_user_id = NEW.enrolled_by_user_id THEN RAISE EXCEPTION 'B2B_PARTICIPATION_SEPARATE_ACCEPTOR_REQUIRED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.terms_version_id IS DISTINCT FROM OLD.terms_version_id OR NEW.terms_digest IS DISTINCT FROM OLD.terms_digest
     OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
     OR NEW.enrolled_by_user_id IS DISTINCT FROM OLD.enrolled_by_user_id OR NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'B2B_PARTICIPATION_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'withdrawn' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'B2B_PARTICIPATION_WITHDRAWN_TERMINAL' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('suspended','withdrawn')) OR
       (OLD.status = 'suspended' AND NEW.status IN ('active','withdrawn'))) THEN
    RAISE EXCEPTION 'B2B_PARTICIPATION_TRANSITION_DENIED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM 'withdrawn' AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_by_user_id IS DISTINCT FROM OLD.withdrawn_by_user_id) THEN
    RAISE EXCEPTION 'B2B_PARTICIPATION_WITHDRAWAL_EVIDENCE_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER b2b_participation_events_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_participation_events FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_participation_events_no_truncate BEFORE TRUNCATE ON b2b_participation_events FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
ALTER TABLE b2b_participation_events ENABLE ALWAYS TRIGGER b2b_participation_events_append_only;
--> statement-breakpoint
ALTER TABLE b2b_participation_events ENABLE ALWAYS TRIGGER b2b_participation_events_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_participations ENABLE ALWAYS TRIGGER b2b_participation_guard_trg;
