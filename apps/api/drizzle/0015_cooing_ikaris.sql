CREATE TABLE "ai_usage_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid,
	"call_site" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"period_type" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_estimate_usd" real,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_log_status_check" CHECK ("ai_usage_log"."status" IN ('success', 'failed', 'blocked')),
	CONSTRAINT "ai_usage_log_period_type_check" CHECK ("ai_usage_log"."period_type" IN ('weekly', 'monthly')),
	CONSTRAINT "ai_usage_log_period_range_check" CHECK ("ai_usage_log"."period_end" > "ai_usage_log"."period_start")
);
--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_log_success_created_idx" ON "ai_usage_log" USING btree ("created_at") WHERE "ai_usage_log"."status" = 'success';--> statement-breakpoint
CREATE INDEX "ai_usage_log_business_created_idx" ON "ai_usage_log" USING btree ("business_id","created_at");