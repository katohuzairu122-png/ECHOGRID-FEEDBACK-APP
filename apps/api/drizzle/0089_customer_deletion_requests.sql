CREATE TABLE "customer_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "customer_deletion_requests_status_check" CHECK ("customer_deletion_requests"."status" IN ('pending', 'cancelled', 'processed')),
	CONSTRAINT "customer_deletion_requests_window_check" CHECK ("customer_deletion_requests"."scheduled_for" = "customer_deletion_requests"."requested_at" + interval '30 days'),
	CONSTRAINT "customer_deletion_requests_cancel_shape_check" CHECK (("customer_deletion_requests"."status" = 'cancelled') = ("customer_deletion_requests"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_deletion_requests" ADD CONSTRAINT "customer_deletion_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_deletion_requests_one_pending_idx" ON "customer_deletion_requests" USING btree ("customer_id") WHERE "customer_deletion_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "customer_deletion_requests_due_idx" ON "customer_deletion_requests" USING btree ("scheduled_for") WHERE "customer_deletion_requests"."status" = 'pending';
--> statement-breakpoint
-- CUST-DEL-01 guard: after INSERT the only permitted change is pending -> cancelled (restore), with every other column unchanged.
-- No DELETE, no TRUNCATE. Processing a request (status 'processed') is a later operator block (CUST-DEL-03) and will extend this guard.
CREATE OR REPLACE FUNCTION customer_deletion_requests_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'pending' AND NEW.status = 'cancelled'
     AND NEW.id = OLD.id AND NEW.customer_id = OLD.customer_id
     AND NEW.requested_at = OLD.requested_at AND NEW.scheduled_for = OLD.scheduled_for THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CUSTOMER_DELETION_REQUEST_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_deletion_requests_guard_trg BEFORE UPDATE OR DELETE ON customer_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION customer_deletion_requests_guard();
--> statement-breakpoint
CREATE TRIGGER customer_deletion_requests_no_truncate BEFORE TRUNCATE ON customer_deletion_requests
  FOR EACH STATEMENT EXECUTE FUNCTION customer_deletion_requests_guard();
--> statement-breakpoint
ALTER TABLE customer_deletion_requests ENABLE ALWAYS TRIGGER customer_deletion_requests_guard_trg;
--> statement-breakpoint
ALTER TABLE customer_deletion_requests ENABLE ALWAYS TRIGGER customer_deletion_requests_no_truncate;
