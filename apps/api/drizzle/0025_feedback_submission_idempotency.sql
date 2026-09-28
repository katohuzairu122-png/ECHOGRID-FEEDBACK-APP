ALTER TABLE "feedback" ADD COLUMN "submission_key" uuid;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "submission_payload_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_submission_key_key" ON "feedback" USING btree ("submission_key");

