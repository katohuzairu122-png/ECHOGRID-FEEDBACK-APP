ALTER TABLE "feedback" ADD COLUMN "normalized_text_hash" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "is_duplicate_text" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "feedback_duplicate_hash_idx" ON "feedback" USING btree ("business_id","branch_id","normalized_text_hash") WHERE "feedback"."normalized_text_hash" IS NOT NULL;
