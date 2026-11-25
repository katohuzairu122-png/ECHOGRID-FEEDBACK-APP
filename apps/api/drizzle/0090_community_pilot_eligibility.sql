CREATE TABLE "community_pilot_eligibility_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "community_pilot_eligibility_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_pilot_events_action_check" CHECK ("community_pilot_eligibility_events"."action" IN ('grant', 'revoke')),
	CONSTRAINT "community_pilot_events_reason_check" CHECK (length(btrim("community_pilot_eligibility_events"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "community_pilot_eligibility_events" ADD CONSTRAINT "community_pilot_eligibility_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_pilot_eligibility_events" ADD CONSTRAINT "community_pilot_eligibility_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_pilot_events_customer_seq_idx" ON "community_pilot_eligibility_events" USING btree ("customer_id","seq");
--> statement-breakpoint
-- Append-only guard (same shape as the 0085 audit_log guard). No DELETE, no TRUNCATE, no ordinary UPDATE. The single permitted UPDATE is
-- PostgreSQL's own ON DELETE SET NULL on actor_user_id (recognised by nesting depth > 1 AND by shape: only that column, only value -> NULL).
CREATE OR REPLACE FUNCTION community_pilot_events_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id')
     AND NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'COMMUNITY_PILOT_EVENTS_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER community_pilot_events_guard_trg BEFORE UPDATE OR DELETE ON community_pilot_eligibility_events
  FOR EACH ROW EXECUTE FUNCTION community_pilot_events_guard();
--> statement-breakpoint
CREATE TRIGGER community_pilot_events_no_truncate BEFORE TRUNCATE ON community_pilot_eligibility_events
  FOR EACH STATEMENT EXECUTE FUNCTION community_pilot_events_guard();
--> statement-breakpoint
ALTER TABLE community_pilot_eligibility_events ENABLE ALWAYS TRIGGER community_pilot_events_guard_trg;
--> statement-breakpoint
ALTER TABLE community_pilot_eligibility_events ENABLE ALWAYS TRIGGER community_pilot_events_no_truncate;
