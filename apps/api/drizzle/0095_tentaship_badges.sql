CREATE TABLE "tentaship_badge_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"participant_type" text NOT NULL,
	"customer_id" uuid,
	"business_id" uuid,
	"evidence_kind" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tentaship_badge_awards_participant_shape" CHECK (("tentaship_badge_awards"."participant_type" = 'customer' AND "tentaship_badge_awards"."customer_id" IS NOT NULL AND "tentaship_badge_awards"."business_id" IS NULL) OR ("tentaship_badge_awards"."participant_type" = 'business' AND "tentaship_badge_awards"."business_id" IS NOT NULL AND "tentaship_badge_awards"."customer_id" IS NULL)),
	CONSTRAINT "tentaship_badge_awards_hash_format" CHECK ("tentaship_badge_awards"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tentaship_badge_definition_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"names" jsonb NOT NULL,
	"descriptions" jsonb NOT NULL,
	"rule" jsonb NOT NULL,
	"rule_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "tentaship_badge_versions_definition_version_uq" UNIQUE("definition_id","version"),
	CONSTRAINT "tentaship_badge_versions_id_definition_uq" UNIQUE("id","definition_id"),
	CONSTRAINT "tentaship_badge_versions_status_valid" CHECK ("tentaship_badge_definition_versions"."status" IN ('draft','active','retired')),
	CONSTRAINT "tentaship_badge_versions_version_positive" CHECK ("tentaship_badge_definition_versions"."version" >= 1),
	CONSTRAINT "tentaship_badge_versions_hash_format" CHECK ("tentaship_badge_definition_versions"."rule_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tentaship_badge_versions_names_en" CHECK (jsonb_typeof("tentaship_badge_definition_versions"."names") = 'object' AND "tentaship_badge_definition_versions"."names" ? 'en'),
	CONSTRAINT "tentaship_badge_versions_lifecycle_shape" CHECK (("tentaship_badge_definition_versions"."status" = 'draft' AND "tentaship_badge_definition_versions"."activated_at" IS NULL AND "tentaship_badge_definition_versions"."retired_at" IS NULL) OR ("tentaship_badge_definition_versions"."status" = 'active' AND "tentaship_badge_definition_versions"."activated_at" IS NOT NULL AND "tentaship_badge_definition_versions"."retired_at" IS NULL) OR ("tentaship_badge_definition_versions"."status" = 'retired' AND "tentaship_badge_definition_versions"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tentaship_badge_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"participant_type" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tentaship_badge_definitions_id_participant_uq" UNIQUE("id","participant_type"),
	CONSTRAINT "tentaship_badge_definitions_key_format" CHECK ("tentaship_badge_definitions"."key" ~ '^[a-z][a-z0-9_]{2,63}$'),
	CONSTRAINT "tentaship_badge_definitions_participant_valid" CHECK ("tentaship_badge_definitions"."participant_type" IN ('customer','business'))
);
--> statement-breakpoint
CREATE TABLE "tentaship_badge_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"award_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"note" text NOT NULL,
	"authorized_by_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tentaship_badge_revocations_reason_valid" CHECK ("tentaship_badge_revocations"."reason_code" IN ('evidence_reversed','fraud_confirmed','eligibility_lost','issued_in_error')),
	CONSTRAINT "tentaship_badge_revocations_note_length" CHECK (char_length("tentaship_badge_revocations"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "tentaship_badge_awards" ADD CONSTRAINT "tentaship_badge_awards_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_awards" ADD CONSTRAINT "tentaship_badge_awards_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_awards" ADD CONSTRAINT "tentaship_badge_awards_version_definition_fk" FOREIGN KEY ("definition_version_id","definition_id") REFERENCES "public"."tentaship_badge_definition_versions"("id","definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_awards" ADD CONSTRAINT "tentaship_badge_awards_definition_participant_fk" FOREIGN KEY ("definition_id","participant_type") REFERENCES "public"."tentaship_badge_definitions"("id","participant_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_definition_versions" ADD CONSTRAINT "tentaship_badge_definition_versions_definition_id_tentaship_badge_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."tentaship_badge_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_definition_versions" ADD CONSTRAINT "tentaship_badge_definition_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_definitions" ADD CONSTRAINT "tentaship_badge_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_revocations" ADD CONSTRAINT "tentaship_badge_revocations_award_id_tentaship_badge_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."tentaship_badge_awards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentaship_badge_revocations" ADD CONSTRAINT "tentaship_badge_revocations_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tentaship_badge_awards_one_per_customer_idx" ON "tentaship_badge_awards" USING btree ("definition_id","customer_id") WHERE "tentaship_badge_awards"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tentaship_badge_awards_one_per_business_idx" ON "tentaship_badge_awards" USING btree ("definition_id","business_id") WHERE "tentaship_badge_awards"."business_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tentaship_badge_awards_evidence_uq" ON "tentaship_badge_awards" USING btree ("definition_id","evidence_kind","evidence_ref");--> statement-breakpoint
CREATE INDEX "tentaship_badge_awards_customer_idx" ON "tentaship_badge_awards" USING btree ("customer_id","awarded_at");--> statement-breakpoint
CREATE INDEX "tentaship_badge_awards_business_idx" ON "tentaship_badge_awards" USING btree ("business_id","awarded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tentaship_badge_versions_one_active_idx" ON "tentaship_badge_definition_versions" USING btree ("definition_id") WHERE "tentaship_badge_definition_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "tentaship_badge_versions_status_idx" ON "tentaship_badge_definition_versions" USING btree ("status","definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tentaship_badge_definitions_key_uq" ON "tentaship_badge_definitions" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "tentaship_badge_revocations_award_uq" ON "tentaship_badge_revocations" USING btree ("award_id");
--> statement-breakpoint
-- TB-02 guards. Definitions are identity-only and immutable. Versions are immutable CONTENT: after INSERT only the lifecycle may move
-- (draft -> active -> retired, or draft -> retired), with every content column unchanged; the activation/retirement timestamps are set by that move.
-- Awards and revocations are APPEND-ONLY evidence. No DELETE and no TRUNCATE anywhere. Reuse of network_truncate_denied() matches 0092/0093.
CREATE OR REPLACE FUNCTION tentaship_badge_versions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.definition_id = OLD.definition_id AND NEW.version = OLD.version
     AND NEW.names = OLD.names AND NEW.descriptions = OLD.descriptions AND NEW.rule = OLD.rule AND NEW.rule_hash = OLD.rule_hash
     AND NEW.created_by_user_id = OLD.created_by_user_id AND NEW.created_at = OLD.created_at
     AND ((OLD.status = 'draft' AND NEW.status IN ('active','retired'))
          OR (OLD.status = 'active' AND NEW.status = 'retired' AND NEW.activated_at = OLD.activated_at)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TENTASHIP_BADGE_VERSION_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tentaship_badge_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'TENTASHIP_BADGE_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_versions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON tentaship_badge_definition_versions
  FOR EACH ROW EXECUTE FUNCTION tentaship_badge_versions_guard();
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_definitions_append_only_trg BEFORE UPDATE OR DELETE ON tentaship_badge_definitions
  FOR EACH ROW EXECUTE FUNCTION tentaship_badge_append_only();
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_awards_append_only_trg BEFORE UPDATE OR DELETE ON tentaship_badge_awards
  FOR EACH ROW EXECUTE FUNCTION tentaship_badge_append_only();
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_revocations_append_only_trg BEFORE UPDATE OR DELETE ON tentaship_badge_revocations
  FOR EACH ROW EXECUTE FUNCTION tentaship_badge_append_only();
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_definitions_no_truncate BEFORE TRUNCATE ON tentaship_badge_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_definition_versions_no_truncate BEFORE TRUNCATE ON tentaship_badge_definition_versions
  FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_awards_no_truncate BEFORE TRUNCATE ON tentaship_badge_awards
  FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER tentaship_badge_revocations_no_truncate BEFORE TRUNCATE ON tentaship_badge_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE tentaship_badge_definition_versions ENABLE ALWAYS TRIGGER tentaship_badge_versions_guard_trg;
--> statement-breakpoint
ALTER TABLE tentaship_badge_definitions ENABLE ALWAYS TRIGGER tentaship_badge_definitions_append_only_trg;
--> statement-breakpoint
ALTER TABLE tentaship_badge_awards ENABLE ALWAYS TRIGGER tentaship_badge_awards_append_only_trg;
--> statement-breakpoint
ALTER TABLE tentaship_badge_revocations ENABLE ALWAYS TRIGGER tentaship_badge_revocations_append_only_trg;
--> statement-breakpoint
ALTER TABLE tentaship_badge_definitions ENABLE ALWAYS TRIGGER tentaship_badge_definitions_no_truncate;
--> statement-breakpoint
ALTER TABLE tentaship_badge_definition_versions ENABLE ALWAYS TRIGGER tentaship_badge_definition_versions_no_truncate;
--> statement-breakpoint
ALTER TABLE tentaship_badge_awards ENABLE ALWAYS TRIGGER tentaship_badge_awards_no_truncate;
--> statement-breakpoint
ALTER TABLE tentaship_badge_revocations ENABLE ALWAYS TRIGGER tentaship_badge_revocations_no_truncate;
