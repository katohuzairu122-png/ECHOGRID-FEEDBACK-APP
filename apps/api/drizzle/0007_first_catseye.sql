CREATE TABLE "fraud_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"feedback_id" uuid,
	"signal_type" text NOT NULL,
	"reason_code" text NOT NULL,
	"severity" text DEFAULT 'low' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" jsonb,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	CONSTRAINT "fraud_signals_severity_check" CHECK ("fraud_signals"."severity" IN ('low', 'medium', 'high')),
	CONSTRAINT "fraud_signals_status_check" CHECK ("fraud_signals"."status" IN ('open', 'reviewed', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fraud_signals_business_branch_detected_idx" ON "fraud_signals" USING btree ("business_id","branch_id","detected_at");--> statement-breakpoint
CREATE INDEX "fraud_signals_business_open_idx" ON "fraud_signals" USING btree ("business_id","detected_at") WHERE "fraud_signals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "fraud_signals_feedback_idx" ON "fraud_signals" USING btree ("feedback_id") WHERE "fraud_signals"."feedback_id" IS NOT NULL;