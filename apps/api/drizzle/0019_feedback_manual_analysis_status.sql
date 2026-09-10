ALTER TABLE "feedback" DROP CONSTRAINT "feedback_analysis_status_check";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_analysis_status_check" CHECK ("feedback"."analysis_status" IN ('pending', 'completed', 'failed', 'skipped', 'manual'));
