ALTER TABLE "ai_usage_log" DROP CONSTRAINT "ai_usage_log_status_check";--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_status_check" CHECK ("ai_usage_log"."status" IN ('pending', 'success', 'failed', 'blocked', 'abandoned'));
