CREATE TABLE "team_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_id" uuid NOT NULL,
	"branch_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "ubr_branch_scoped_unique";--> statement-breakpoint
DROP INDEX "ubr_business_wide_unique";--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invitations_token_hash_key" ON "team_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "team_invitations_business_id_idx" ON "team_invitations" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_invitations_pending_branch_scope_key" ON "team_invitations" USING btree ("business_id","email","role_id","branch_id") WHERE "team_invitations"."branch_id" IS NOT NULL AND "team_invitations"."accepted_at" IS NULL AND "team_invitations"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invitations_pending_business_scope_key" ON "team_invitations" USING btree ("business_id","email","role_id") WHERE "team_invitations"."branch_id" IS NULL AND "team_invitations"."accepted_at" IS NULL AND "team_invitations"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ubr_branch_scoped_unique" ON "user_business_roles" USING btree ("user_id","business_id","branch_id","role_id") WHERE "user_business_roles"."branch_id" IS NOT NULL AND "user_business_roles"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ubr_business_wide_unique" ON "user_business_roles" USING btree ("user_id","business_id","role_id") WHERE "user_business_roles"."branch_id" IS NULL AND "user_business_roles"."deleted_at" IS NULL;