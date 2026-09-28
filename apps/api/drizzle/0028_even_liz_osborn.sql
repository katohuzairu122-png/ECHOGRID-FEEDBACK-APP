ALTER TABLE "feedback_questions" DROP CONSTRAINT "feedback_questions_type_check";--> statement-breakpoint
ALTER TABLE "feedback_questions" ADD CONSTRAINT "feedback_questions_type_check" CHECK ("feedback_questions"."type" IN ('text','textarea','rating','single_choice','multi_choice','boolean'));
