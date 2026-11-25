CREATE TABLE "network_follows" (
	"customer_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_follows_customer_id_business_id_pk" PRIMARY KEY("customer_id","business_id")
);
--> statement-breakpoint
ALTER TABLE "network_follows" ADD CONSTRAINT "network_follows_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_follows" ADD CONSTRAINT "network_follows_business_id_business_public_profiles_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business_public_profiles"("business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_follows_business_idx" ON "network_follows" USING btree ("business_id","created_at");
--> statement-breakpoint
-- A follow can only be CREATED for a business whose public profile is published and whose business is active (NETWORK-00 section 3). Later
-- unpublication or suspension does not delete the row: the visibility predicate hides the business, and the follow is simply inert.
CREATE OR REPLACE FUNCTION network_follow_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a follow is never updated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM business_public_profiles p JOIN businesses b ON b.id = p.business_id
     WHERE p.business_id = NEW.business_id AND p.publication_state = 'published' AND b.status = 'active'
  ) THEN
    RAISE EXCEPTION 'only a published, active business can be followed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER network_follow_guard_trg BEFORE INSERT OR UPDATE ON network_follows
  FOR EACH ROW EXECUTE FUNCTION network_follow_guard();
--> statement-breakpoint
ALTER TABLE network_follows ENABLE ALWAYS TRIGGER network_follow_guard_trg;
--> statement-breakpoint
CREATE TRIGGER network_follows_no_truncate BEFORE TRUNCATE ON network_follows
  FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE network_follows ENABLE ALWAYS TRIGGER network_follows_no_truncate;
