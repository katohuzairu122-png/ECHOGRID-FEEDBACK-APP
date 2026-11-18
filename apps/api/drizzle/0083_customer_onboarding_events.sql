CREATE TABLE "customer_onboarding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_id" uuid,
	"cashier_user_id" uuid,
	"source" text NOT NULL,
	"verification_state" text NOT NULL,
	"consent_grant_id" uuid,
	"reference" text,
	"is_rejoin" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"audit_log_id" uuid,
	CONSTRAINT "customer_onboarding_events_source_check" CHECK ("customer_onboarding_events"."source" IN ('business_qr','cashier_assisted','remote_invitation')),
	CONSTRAINT "customer_onboarding_events_verification_check" CHECK ("customer_onboarding_events"."verification_state" IN ('unverified','phone_verified','email_verified','phone_and_email_verified')),
	CONSTRAINT "customer_onboarding_events_cashier_shape_check" CHECK (("customer_onboarding_events"."source" = 'cashier_assisted') = ("customer_onboarding_events"."cashier_user_id" IS NOT NULL)),
	CONSTRAINT "customer_onboarding_events_assisted_branch_check" CHECK ("customer_onboarding_events"."source" <> 'cashier_assisted' OR "customer_onboarding_events"."branch_id" IS NOT NULL),
	CONSTRAINT "customer_onboarding_events_assisted_reference_check" CHECK ("customer_onboarding_events"."source" <> 'cashier_assisted' OR "customer_onboarding_events"."reference" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_membership_id_business_customer_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."business_customer_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_consent_grant_id_consent_grants_id_fk" FOREIGN KEY ("consent_grant_id") REFERENCES "public"."consent_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding_events" ADD CONSTRAINT "customer_onboarding_events_audit_log_id_audit_log_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_log"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_onboarding_events_business_occurred_idx" ON "customer_onboarding_events" USING btree ("business_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_onboarding_events_business_branch_idx" ON "customer_onboarding_events" USING btree ("business_id","branch_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_onboarding_events_business_cashier_idx" ON "customer_onboarding_events" USING btree ("business_id","cashier_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_onboarding_events_membership_idx" ON "customer_onboarding_events" USING btree ("membership_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_onboarding_events_customer_idx" ON "customer_onboarding_events" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_onboarding_events_invite_once_key" ON "customer_onboarding_events" USING btree ("business_id","reference") WHERE "customer_onboarding_events"."source" = 'cashier_assisted';--> statement-breakpoint
-- CASHIER-AUTH-02D guards. The table is append-only and tenant-consistent at the DATABASE level, so no application bug or
-- direct SQL can re-attribute, rewrite or delete an onboarding record, or record one across businesses.
CREATE OR REPLACE FUNCTION customer_onboarding_event_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  membership_row business_customer_memberships%ROWTYPE;
  branch_business uuid;
  grant_row consent_grants%ROWTYPE;
  audit_business uuid;
  audit_found boolean;
  cashier_row users%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ONBOARDING_EVENT_APPEND_ONLY (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO membership_row FROM business_customer_memberships WHERE id = NEW.membership_id;
  IF NOT FOUND OR membership_row.business_id <> NEW.business_id OR membership_row.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'ONBOARDING_EVENT_MEMBERSHIP_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.branch_id IS NOT NULL THEN
    SELECT business_id INTO branch_business FROM branches WHERE id = NEW.branch_id;
    IF branch_business IS NULL OR branch_business <> NEW.business_id THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_BRANCH_NOT_IN_BUSINESS' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.consent_grant_id IS NOT NULL THEN
    SELECT * INTO grant_row FROM consent_grants WHERE id = NEW.consent_grant_id;
    IF NOT FOUND OR grant_row.customer_id <> NEW.customer_id OR grant_row.business_id <> NEW.business_id
       OR grant_row.purpose <> 'join_loyalty' THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_CONSENT_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.audit_log_id IS NOT NULL THEN
    SELECT business_id, true INTO audit_business, audit_found FROM audit_log WHERE id = NEW.audit_log_id;
    IF audit_found IS NOT TRUE OR audit_business IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_AUDIT_MISMATCH' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.cashier_user_id IS NOT NULL THEN
    SELECT * INTO cashier_row FROM users WHERE id = NEW.cashier_user_id;
    IF NOT FOUND OR cashier_row.status <> 'active'
       OR (cashier_row.managed_business_id IS NOT NULL AND cashier_row.managed_business_id <> NEW.business_id) THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_CASHIER_NOT_ELIGIBLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM user_business_roles ubr
      WHERE ubr.user_id = NEW.cashier_user_id AND ubr.business_id = NEW.business_id AND ubr.deleted_at IS NULL
        AND (ubr.branch_id IS NULL OR ubr.branch_id = NEW.branch_id)
    ) THEN
      RAISE EXCEPTION 'ONBOARDING_EVENT_CASHIER_NOT_AUTHORIZED_FOR_BRANCH' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER customer_onboarding_event_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON customer_onboarding_events
  FOR EACH ROW EXECUTE FUNCTION customer_onboarding_event_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION customer_onboarding_event_truncate_denied() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ONBOARDING_EVENT_TRUNCATE_DENIED' USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER customer_onboarding_events_no_truncate BEFORE TRUNCATE ON customer_onboarding_events
  FOR EACH STATEMENT EXECUTE FUNCTION customer_onboarding_event_truncate_denied();
--> statement-breakpoint
ALTER TABLE customer_onboarding_events ENABLE ALWAYS TRIGGER customer_onboarding_event_guard_trg;
--> statement-breakpoint
ALTER TABLE customer_onboarding_events ENABLE ALWAYS TRIGGER customer_onboarding_events_no_truncate;
