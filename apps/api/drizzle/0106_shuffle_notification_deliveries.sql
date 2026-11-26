CREATE TABLE "shuffle_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"notification_class" text NOT NULL,
	"channel" text NOT NULL,
	"template_version" text NOT NULL,
	"attempt" integer NOT NULL,
	"state" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"provider_message_id" text,
	"error" text,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_notification_deliveries_state" CHECK ("shuffle_notification_deliveries"."state" IN ('held','blocked','delivered','failed')),
	CONSTRAINT "shuffle_notification_deliveries_synthetic" CHECK ("shuffle_notification_deliveries"."synthetic" = true),
	CONSTRAINT "shuffle_notification_deliveries_attempt" CHECK ("shuffle_notification_deliveries"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "shuffle_notification_deliveries" ADD CONSTRAINT "shuffle_notification_deliveries_intent_id_shuffle_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."shuffle_notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_notification_deliveries" ADD CONSTRAINT "shuffle_notification_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_notification_deliveries_attempt_uq" ON "shuffle_notification_deliveries" USING btree ("intent_id","attempt");--> statement-breakpoint
CREATE INDEX "shuffle_notification_deliveries_intent_idx" ON "shuffle_notification_deliveries" USING btree ("intent_id","attempt");--> statement-breakpoint
CREATE OR REPLACE FUNCTION shuffle_notification_deliveries_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE inv_customer uuid; last_attempt integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_DELIVERY_APPEND_ONLY (%): a delivery decision is never rewritten', TG_OP USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT i.customer_id INTO inv_customer FROM shuffle_notification_intents n JOIN shuffle_invitations i ON i.id = n.invitation_id WHERE n.id = NEW.intent_id;
  IF inv_customer IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'NOTIFICATION_DELIVERY_NOT_ALLOWED (the recipient must be the invitation customer)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT max(attempt) INTO last_attempt FROM shuffle_notification_deliveries WHERE intent_id = NEW.intent_id;
  IF NEW.attempt <> COALESCE(last_attempt, 0) + 1 THEN
    RAISE EXCEPTION 'NOTIFICATION_DELIVERY_NOT_ALLOWED (attempts are contiguous)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM shuffle_notification_deliveries WHERE intent_id = NEW.intent_id AND state = 'delivered') THEN
    RAISE EXCEPTION 'NOTIFICATION_DELIVERY_NOT_ALLOWED (an intent is delivered at most once)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shuffle_notification_deliveries_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON shuffle_notification_deliveries FOR EACH ROW EXECUTE FUNCTION shuffle_notification_deliveries_guard();
--> statement-breakpoint
CREATE TRIGGER shuffle_notification_deliveries_no_truncate BEFORE TRUNCATE ON shuffle_notification_deliveries FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE shuffle_notification_deliveries ENABLE ALWAYS TRIGGER shuffle_notification_deliveries_guard_trg;
--> statement-breakpoint
ALTER TABLE shuffle_notification_deliveries ENABLE ALWAYS TRIGGER shuffle_notification_deliveries_no_truncate;
