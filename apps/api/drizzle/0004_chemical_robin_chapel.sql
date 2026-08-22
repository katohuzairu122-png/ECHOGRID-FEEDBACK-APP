CREATE TABLE "critical_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"feedback_id" uuid NOT NULL,
	"matched_signals" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "critical_incidents_feedback_id_unique" UNIQUE("feedback_id")
);
--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_sentiment_check";--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "urgency" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "critical_incidents" ADD CONSTRAINT "critical_incidents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critical_incidents" ADD CONSTRAINT "critical_incidents_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critical_incidents" ADD CONSTRAINT "critical_incidents_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "critical_incidents_business_created_idx" ON "critical_incidents" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "critical_incidents_unacknowledged_idx" ON "critical_incidents" USING btree ("business_id","created_at") WHERE "critical_incidents"."acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "feedback_business_category_idx" ON "feedback" USING btree ("business_id","category");--> statement-breakpoint
CREATE INDEX "feedback_business_urgency_idx" ON "feedback" USING btree ("business_id","urgency");--> statement-breakpoint
CREATE INDEX "feedback_business_assigned_idx" ON "feedback" USING btree ("business_id","assigned_to");--> statement-breakpoint
CREATE INDEX "feedback_critical_idx" ON "feedback" USING btree ("business_id","created_at") WHERE "feedback"."urgency" = 'P0_CRITICAL';--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_urgency_check" CHECK ("feedback"."urgency" IS NULL OR "feedback"."urgency" IN ('P0_CRITICAL', 'P1_HIGH', 'P2_NORMAL', 'P3_LOW'));--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_sentiment_check" CHECK ("feedback"."sentiment" IS NULL OR "feedback"."sentiment" IN ('very_negative', 'negative', 'neutral', 'positive', 'very_positive', 'unknown'));