ALTER TABLE "ai_usage_log" DROP CONSTRAINT "ai_usage_log_status_check";--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ai_usage_log_pending_created_idx" ON "ai_usage_log" USING btree ("created_at") WHERE "ai_usage_log"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_status_check" CHECK ("ai_usage_log"."status" IN ('pending', 'success', 'failed', 'blocked'));