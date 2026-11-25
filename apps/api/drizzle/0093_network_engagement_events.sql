CREATE TABLE "network_engagement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_day" text DEFAULT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') NOT NULL,
	CONSTRAINT "network_engagement_type_valid" CHECK ("network_engagement_events"."event_type" IN ('impression','engagement','follow','unfollow')),
	CONSTRAINT "network_engagement_day_format" CHECK ("network_engagement_events"."event_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "network_engagement_events" ADD CONSTRAINT "network_engagement_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_engagement_events" ADD CONSTRAINT "network_engagement_events_business_id_business_public_profiles_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_public_profiles"("business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "network_engagement_once_per_day_uq" ON "network_engagement_events" USING btree ("customer_id","event_type","subject_id","event_day") WHERE "network_engagement_events"."event_type" IN ('impression','engagement');--> statement-breakpoint
CREATE INDEX "network_engagement_business_idx" ON "network_engagement_events" USING btree ("business_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "network_engagement_subject_idx" ON "network_engagement_events" USING btree ("subject_id","event_type");
--> statement-breakpoint
-- Append-only evidence: an event is never edited. Rows leave only through the customer-account cascade (a deleted account takes its events).
CREATE OR REPLACE FUNCTION network_engagement_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'network engagement events are append-only' USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER network_engagement_no_update BEFORE UPDATE ON network_engagement_events
  FOR EACH ROW EXECUTE FUNCTION network_engagement_guard();
--> statement-breakpoint
CREATE TRIGGER network_engagement_no_truncate BEFORE TRUNCATE ON network_engagement_events
  FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE network_engagement_events ENABLE ALWAYS TRIGGER network_engagement_no_update;
--> statement-breakpoint
ALTER TABLE network_engagement_events ENABLE ALWAYS TRIGGER network_engagement_no_truncate;
