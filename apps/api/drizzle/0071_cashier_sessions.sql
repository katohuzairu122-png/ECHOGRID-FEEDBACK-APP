ALTER TABLE "refresh_tokens" ADD COLUMN "client" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "device_label" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_client_check" CHECK ("refresh_tokens"."client" IN ('web', 'cashier'));--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_cashier_binding_check" CHECK (("refresh_tokens"."client" = 'web' AND "refresh_tokens"."business_id" IS NULL AND "refresh_tokens"."branch_id" IS NULL) OR ("refresh_tokens"."client" = 'cashier' AND "refresh_tokens"."business_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_label_check" CHECK ("refresh_tokens"."device_label" IS NULL OR (length(btrim("refresh_tokens"."device_label")) > 0 AND length("refresh_tokens"."device_label") <= 80));