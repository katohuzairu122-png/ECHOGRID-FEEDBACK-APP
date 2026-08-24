CREATE TABLE "visit_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "visit_sessions_status_check" CHECK ("visit_sessions"."status" IN ('active', 'revoked')),
	CONSTRAINT "visit_sessions_max_uses_check" CHECK ("visit_sessions"."max_uses" IS NULL OR "visit_sessions"."max_uses" > 0)
);
--> statement-breakpoint
ALTER TABLE "visit_sessions" ADD CONSTRAINT "visit_sessions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_sessions" ADD CONSTRAINT "visit_sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_sessions_branch_code_active_key" ON "visit_sessions" USING btree ("branch_id","code") WHERE "visit_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "visit_sessions_business_branch_idx" ON "visit_sessions" USING btree ("business_id","branch_id");