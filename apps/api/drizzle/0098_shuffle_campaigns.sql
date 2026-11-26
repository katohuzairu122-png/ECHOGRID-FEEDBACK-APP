CREATE TABLE "shuffle_campaign_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"version" integer NOT NULL,
	"qualification_rule_version_id" uuid NOT NULL,
	"min_participants" integer NOT NULL,
	"max_capacity" integer NOT NULL,
	"qualification_window_start" timestamp with time zone NOT NULL,
	"qualification_window_end" timestamp with time zone NOT NULL,
	"entry_acceptance_deadline" timestamp with time zone NOT NULL,
	"disclosure" jsonb NOT NULL,
	"disclosure_hash" text NOT NULL,
	"terms_version" text NOT NULL,
	"closure_conditions" text NOT NULL,
	"cancellation_conditions" text NOT NULL,
	"content_hash" text NOT NULL,
	"release_state" text DEFAULT 'not_released' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_campaign_versions_campaign_version_uq" UNIQUE("campaign_id","version"),
	CONSTRAINT "shuffle_campaign_versions_id_campaign_uq" UNIQUE("id","campaign_id"),
	CONSTRAINT "shuffle_versions_limits" CHECK ("shuffle_campaign_versions"."min_participants" >= 1 AND "shuffle_campaign_versions"."max_capacity" >= "shuffle_campaign_versions"."min_participants"),
	CONSTRAINT "shuffle_versions_window" CHECK ("shuffle_campaign_versions"."qualification_window_end" > "shuffle_campaign_versions"."qualification_window_start" AND "shuffle_campaign_versions"."entry_acceptance_deadline" > "shuffle_campaign_versions"."qualification_window_start"),
	CONSTRAINT "shuffle_versions_hashes" CHECK ("shuffle_campaign_versions"."disclosure_hash" ~ '^[0-9a-f]{64}$' AND "shuffle_campaign_versions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "shuffle_versions_text" CHECK (char_length("shuffle_campaign_versions"."terms_version") BETWEEN 1 AND 64 AND char_length("shuffle_campaign_versions"."closure_conditions") BETWEEN 1 AND 1000 AND char_length("shuffle_campaign_versions"."cancellation_conditions") BETWEEN 1 AND 1000),
	CONSTRAINT "shuffle_versions_disclosure_en" CHECK (jsonb_typeof("shuffle_campaign_versions"."disclosure") = 'object' AND "shuffle_campaign_versions"."disclosure" ? 'en'),
	CONSTRAINT "shuffle_versions_not_released" CHECK ("shuffle_campaign_versions"."release_state" = 'not_released'),
	CONSTRAINT "shuffle_versions_version_positive" CHECK ("shuffle_campaign_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "shuffle_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone,
	"status_changed_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_campaigns_id_mode_uq" UNIQUE("id","mode"),
	CONSTRAINT "shuffle_campaigns_key_format" CHECK ("shuffle_campaigns"."key" ~ '^[a-z][a-z0-9_]{2,63}$'),
	CONSTRAINT "shuffle_campaigns_mode_valid" CHECK ("shuffle_campaigns"."mode" IN ('guaranteed','limited')),
	CONSTRAINT "shuffle_campaigns_status_valid" CHECK ("shuffle_campaigns"."status" IN ('draft','suspended','cancelled')),
	CONSTRAINT "shuffle_campaigns_status_shape" CHECK (("shuffle_campaigns"."status" = 'draft' AND "shuffle_campaigns"."status_reason" IS NULL) OR ("shuffle_campaigns"."status" <> 'draft' AND "shuffle_campaigns"."status_reason" IS NOT NULL AND "shuffle_campaigns"."status_changed_at" IS NOT NULL AND "shuffle_campaigns"."status_changed_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "shuffle_eligibility_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"qualified" boolean NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_snapshots_hash" CHECK ("shuffle_eligibility_snapshots"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "shuffle_campaign_versions" ADD CONSTRAINT "shuffle_campaign_versions_qualification_rule_version_id_qualification_rule_versions_id_fk" FOREIGN KEY ("qualification_rule_version_id") REFERENCES "public"."qualification_rule_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_campaign_versions" ADD CONSTRAINT "shuffle_campaign_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_campaign_versions" ADD CONSTRAINT "shuffle_versions_campaign_mode_fk" FOREIGN KEY ("campaign_id","mode") REFERENCES "public"."shuffle_campaigns"("id","mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_campaigns" ADD CONSTRAINT "shuffle_campaigns_status_changed_by_user_id_users_id_fk" FOREIGN KEY ("status_changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_campaigns" ADD CONSTRAINT "shuffle_campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_eligibility_snapshots" ADD CONSTRAINT "shuffle_eligibility_snapshots_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_eligibility_snapshots" ADD CONSTRAINT "shuffle_eligibility_snapshots_rule_version_id_qualification_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."qualification_rule_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_eligibility_snapshots" ADD CONSTRAINT "shuffle_snapshots_version_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."shuffle_campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shuffle_campaign_versions_campaign_idx" ON "shuffle_campaign_versions" USING btree ("campaign_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_campaigns_key_uq" ON "shuffle_campaigns" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_snapshots_once_uq" ON "shuffle_eligibility_snapshots" USING btree ("campaign_version_id","customer_id");--> statement-breakpoint
CREATE INDEX "shuffle_snapshots_version_idx" ON "shuffle_eligibility_snapshots" USING btree ("campaign_version_id","qualified");
--> statement-breakpoint
-- TSH-03 guards. Campaigns: after INSERT only a status move (draft -> suspended | cancelled; suspended -> draft | cancelled; cancelled is final) with the reason,
-- time and actor stamped together; every other column is immutable. Versions and snapshots are APPEND-ONLY. No DELETE, no TRUNCATE.
CREATE OR REPLACE FUNCTION shuffle_campaigns_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.key = OLD.key AND NEW.mode = OLD.mode AND NEW.created_by_user_id = OLD.created_by_user_id AND NEW.created_at = OLD.created_at
     AND ((OLD.status = 'draft' AND NEW.status IN ('suspended','cancelled'))
          OR (OLD.status = 'suspended' AND NEW.status IN ('draft','cancelled'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SHUFFLE_CAMPAIGN_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shuffle_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'SHUFFLE_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shuffle_campaigns_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON shuffle_campaigns FOR EACH ROW EXECUTE FUNCTION shuffle_campaigns_guard();
--> statement-breakpoint
CREATE TRIGGER shuffle_versions_append_only_trg BEFORE UPDATE OR DELETE ON shuffle_campaign_versions FOR EACH ROW EXECUTE FUNCTION shuffle_append_only();
--> statement-breakpoint
CREATE TRIGGER shuffle_snapshots_append_only_trg BEFORE UPDATE OR DELETE ON shuffle_eligibility_snapshots FOR EACH ROW EXECUTE FUNCTION shuffle_append_only();
--> statement-breakpoint
CREATE TRIGGER shuffle_campaigns_no_truncate BEFORE TRUNCATE ON shuffle_campaigns FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER shuffle_versions_no_truncate BEFORE TRUNCATE ON shuffle_campaign_versions FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER shuffle_snapshots_no_truncate BEFORE TRUNCATE ON shuffle_eligibility_snapshots FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE shuffle_campaigns ENABLE ALWAYS TRIGGER shuffle_campaigns_guard_trg;
--> statement-breakpoint
ALTER TABLE shuffle_campaign_versions ENABLE ALWAYS TRIGGER shuffle_versions_append_only_trg;
--> statement-breakpoint
ALTER TABLE shuffle_eligibility_snapshots ENABLE ALWAYS TRIGGER shuffle_snapshots_append_only_trg;
--> statement-breakpoint
ALTER TABLE shuffle_campaigns ENABLE ALWAYS TRIGGER shuffle_campaigns_no_truncate;
--> statement-breakpoint
ALTER TABLE shuffle_campaign_versions ENABLE ALWAYS TRIGGER shuffle_versions_no_truncate;
--> statement-breakpoint
ALTER TABLE shuffle_eligibility_snapshots ENABLE ALWAYS TRIGGER shuffle_snapshots_no_truncate;
