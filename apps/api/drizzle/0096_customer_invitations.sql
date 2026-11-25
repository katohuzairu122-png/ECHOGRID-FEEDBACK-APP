CREATE TABLE "customer_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"request_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "customer_invitations_expiry_check" CHECK ("customer_invitations"."expires_at" > "customer_invitations"."created_at"),
	CONSTRAINT "customer_invitations_revoke_shape_check" CHECK (("customer_invitations"."revoked_at" IS NULL) = ("customer_invitations"."revoked_by_user_id" IS NULL)),
	CONSTRAINT "customer_invitations_request_key_length" CHECK ("customer_invitations"."request_key" IS NULL OR char_length("customer_invitations"."request_key") BETWEEN 8 AND 64)
);
--> statement-breakpoint
ALTER TABLE "customer_invitations" ADD CONSTRAINT "customer_invitations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invitations" ADD CONSTRAINT "customer_invitations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invitations" ADD CONSTRAINT "customer_invitations_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invitations" ADD CONSTRAINT "customer_invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_invitations_request_key_uq" ON "customer_invitations" USING btree ("business_id","issued_by_user_id","request_key") WHERE "customer_invitations"."request_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_invitations_business_created_idx" ON "customer_invitations" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_onboarding_events_remote_invite_once_key" ON "customer_onboarding_events" USING btree ("business_id","reference") WHERE "customer_onboarding_events"."source" = 'remote_invitation';
--> statement-breakpoint
-- OWNER-INVITE-01 guard: an invitation is evidence. After INSERT the only permitted change is the ONE-TIME revocation (revoked_at and
-- revoked_by_user_id set together, every other column unchanged). No DELETE, no TRUNCATE.
CREATE OR REPLACE FUNCTION customer_invitations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.revoked_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.business_id = OLD.business_id AND NEW.branch_id = OLD.branch_id
     AND NEW.issued_by_user_id = OLD.issued_by_user_id AND NEW.request_key IS NOT DISTINCT FROM OLD.request_key
     AND NEW.created_at = OLD.created_at AND NEW.expires_at = OLD.expires_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CUSTOMER_INVITATION_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_invitations_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON customer_invitations
  FOR EACH ROW EXECUTE FUNCTION customer_invitations_guard();
--> statement-breakpoint
CREATE TRIGGER customer_invitations_no_truncate BEFORE TRUNCATE ON customer_invitations
  FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE customer_invitations ENABLE ALWAYS TRIGGER customer_invitations_guard_trg;
--> statement-breakpoint
ALTER TABLE customer_invitations ENABLE ALWAYS TRIGGER customer_invitations_no_truncate;
