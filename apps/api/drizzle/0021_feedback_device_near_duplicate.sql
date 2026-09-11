ALTER TABLE "feedback" ADD COLUMN "device_hash" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "near_duplicate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "feedback_device_recent_idx" ON "feedback" USING btree ("business_id","branch_id","device_hash","created_at") WHERE "feedback"."device_hash" IS NOT NULL;
