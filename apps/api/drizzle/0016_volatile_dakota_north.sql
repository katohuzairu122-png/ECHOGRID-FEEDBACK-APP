ALTER TABLE "feedback_summaries" DROP CONSTRAINT "feedback_summaries_period_type_check";--> statement-breakpoint
ALTER TABLE "ai_usage_log" DROP CONSTRAINT "ai_usage_log_period_type_check";--> statement-breakpoint
ALTER TABLE "feedback_summaries" ADD CONSTRAINT "feedback_summaries_period_type_check" CHECK ("feedback_summaries"."period_type" IN ('daily', 'weekly', 'monthly'));--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_period_type_check" CHECK ("ai_usage_log"."period_type" IN ('daily', 'weekly', 'monthly'));