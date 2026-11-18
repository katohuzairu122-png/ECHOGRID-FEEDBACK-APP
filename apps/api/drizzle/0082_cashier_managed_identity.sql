ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "cashier_code" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "cashier_code_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "managed_business_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "managed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credential_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_managed_business_id_businesses_id_fk" FOREIGN KEY ("managed_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_managed_by_user_id_users_id_fk" FOREIGN KEY ("managed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_managed_username_key" ON "users" USING btree ("managed_business_id","login_username") WHERE "users"."managed_business_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_cashier_code_unique" UNIQUE("cashier_code");--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_cashier_code_check" CHECK ("businesses"."cashier_code" IS NULL OR "businesses"."cashier_code" ~ '^[A-HJ-NP-Z2-9]{10}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_managed_shape_check" CHECK (("users"."managed_business_id" IS NULL AND "users"."login_username" IS NULL AND "users"."managed_by_user_id" IS NULL AND "users"."email" IS NOT NULL)
        OR ("users"."managed_business_id" IS NOT NULL AND "users"."login_username" IS NOT NULL AND "users"."managed_by_user_id" IS NOT NULL AND "users"."email" IS NULL AND "users"."email_verified_at" IS NULL AND "users"."platform_role" IS NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_login_username_check" CHECK ("users"."login_username" IS NULL OR "users"."login_username" ~ '^[a-z0-9][a-z0-9._-]{2,31}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_count_check" CHECK ("users"."failed_login_count" >= 0);--> statement-breakpoint
-- CASHIER-AUTH-02A guards (owner rulings D-1, D-2). Enforced in the database so a direct SQL session cannot bypass them.
-- 1) A managed identity's business binding and provisioning record are immutable, in BOTH directions: an ordinary user can
--    never be converted into a managed one, and a managed one can never be re-homed to another business.
CREATE OR REPLACE FUNCTION users_managed_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.managed_business_id IS DISTINCT FROM OLD.managed_business_id THEN
    RAISE EXCEPTION 'MANAGED_IDENTITY_BINDING_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.managed_by_user_id IS DISTINCT FROM OLD.managed_by_user_id THEN
    RAISE EXCEPTION 'MANAGED_IDENTITY_PROVISIONER_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER users_managed_identity_guard_trg BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_managed_identity_guard();
--> statement-breakpoint
ALTER TABLE users ENABLE ALWAYS TRIGGER users_managed_identity_guard_trg;
--> statement-breakpoint
-- 2) A managed identity can hold ONLY branch-scoped grants of its own business's system role named 'Cashier'. No business-wide
--    grant, no other role, no other business, no branch of another business, can ever be written for it.
CREATE OR REPLACE FUNCTION user_business_roles_managed_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  managed_business uuid;
  role_row roles%ROWTYPE;
  branch_business uuid;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT managed_business_id INTO managed_business FROM users WHERE id = NEW.user_id;
  IF managed_business IS NULL THEN RETURN NEW; END IF;
  IF NEW.business_id <> managed_business THEN
    RAISE EXCEPTION 'MANAGED_CASHIER_GRANT_WRONG_BUSINESS' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'MANAGED_CASHIER_GRANT_REQUIRES_BRANCH' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT business_id INTO branch_business FROM branches WHERE id = NEW.branch_id;
  IF branch_business IS DISTINCT FROM managed_business THEN
    RAISE EXCEPTION 'MANAGED_CASHIER_GRANT_WRONG_BRANCH' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO role_row FROM roles WHERE id = NEW.role_id;
  IF NOT FOUND OR role_row.business_id <> managed_business OR role_row.name <> 'Cashier' OR NOT role_row.is_system THEN
    RAISE EXCEPTION 'MANAGED_CASHIER_ROLE_RESTRICTED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER user_business_roles_managed_guard_trg BEFORE INSERT OR UPDATE ON user_business_roles FOR EACH ROW EXECUTE FUNCTION user_business_roles_managed_guard();
--> statement-breakpoint
ALTER TABLE user_business_roles ENABLE ALWAYS TRIGGER user_business_roles_managed_guard_trg;
--> statement-breakpoint
-- 3) TRUNCATE bypasses row triggers, so both guarded tables also deny it (the repository-wide structural guard in
--    financial-truncate-denial requires this), and the denial is ENABLE ALWAYS so session_replication_role = replica cannot skip it.
CREATE OR REPLACE FUNCTION cashier_identity_truncate_denied() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'CASHIER_IDENTITY_TRUNCATE_DENIED (%)', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER users_no_truncate BEFORE TRUNCATE ON users FOR EACH STATEMENT EXECUTE FUNCTION cashier_identity_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER user_business_roles_no_truncate BEFORE TRUNCATE ON user_business_roles FOR EACH STATEMENT EXECUTE FUNCTION cashier_identity_truncate_denied();
--> statement-breakpoint
ALTER TABLE users ENABLE ALWAYS TRIGGER users_no_truncate;
--> statement-breakpoint
ALTER TABLE user_business_roles ENABLE ALWAYS TRIGGER user_business_roles_no_truncate;
