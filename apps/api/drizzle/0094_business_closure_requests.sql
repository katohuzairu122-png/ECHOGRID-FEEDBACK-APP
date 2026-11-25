CREATE TABLE "business_closure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"obligations_snapshot" jsonb NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	CONSTRAINT "business_closure_requests_status_check" CHECK ("business_closure_requests"."status" IN ('pending', 'cancelled', 'processed')),
	CONSTRAINT "business_closure_requests_cancel_shape_check" CHECK (("business_closure_requests"."status" = 'cancelled') = ("business_closure_requests"."cancelled_at" IS NOT NULL AND "business_closure_requests"."cancelled_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "business_closure_requests" ADD CONSTRAINT "business_closure_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_closure_requests" ADD CONSTRAINT "business_closure_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_closure_requests" ADD CONSTRAINT "business_closure_requests_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_closure_requests_one_pending_idx" ON "business_closure_requests" USING btree ("business_id") WHERE "business_closure_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "business_closure_requests_business_idx" ON "business_closure_requests" USING btree ("business_id","requested_at");--> statement-breakpoint
CREATE INDEX "business_closure_requests_pending_idx" ON "business_closure_requests" USING btree ("requested_at") WHERE "business_closure_requests"."status" = 'pending';
--> statement-breakpoint
-- BIZ-CLOSE-01 guard: a closure REQUEST is evidence. INSERT must be `pending` (`processed` is reserved: closure processing is a blocked
-- state until settlement, forfeiture, refund and retention policy are approved). After INSERT the only permitted change is
-- pending -> cancelled (owner withdrawal) with every other column unchanged. No DELETE, no TRUNCATE.
CREATE OR REPLACE FUNCTION business_closure_requests_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'pending' AND NEW.status = 'cancelled'
     AND NEW.id = OLD.id AND NEW.business_id = OLD.business_id AND NEW.requested_by_user_id = OLD.requested_by_user_id
     AND NEW.requested_at = OLD.requested_at AND NEW.obligations_snapshot = OLD.obligations_snapshot THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BUSINESS_CLOSURE_REQUEST_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER business_closure_requests_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON business_closure_requests
  FOR EACH ROW EXECUTE FUNCTION business_closure_requests_guard();
--> statement-breakpoint
CREATE TRIGGER business_closure_requests_no_truncate BEFORE TRUNCATE ON business_closure_requests
  FOR EACH STATEMENT EXECUTE FUNCTION business_closure_requests_guard();
--> statement-breakpoint
ALTER TABLE business_closure_requests ENABLE ALWAYS TRIGGER business_closure_requests_guard_trg;
--> statement-breakpoint
ALTER TABLE business_closure_requests ENABLE ALWAYS TRIGGER business_closure_requests_no_truncate;
