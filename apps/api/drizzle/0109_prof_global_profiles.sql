CREATE TABLE "business_appearance" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"logo_key" text,
	"brand_color_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "business_appearance_logo_key_check" CHECK ("business_appearance"."logo_key" IS NULL OR "business_appearance"."logo_key" ~ '^[a-z]{2,24}$'),
	CONSTRAINT "business_appearance_brand_color_check" CHECK ("business_appearance"."brand_color_key" IS NULL OR "business_appearance"."brand_color_key" ~ '^[a-z]{2,24}$')
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "business_appearance" ADD CONSTRAINT "business_appearance_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_display_name_check" CHECK ("customers"."display_name" IS NULL OR char_length("customers"."display_name") BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_bio_check" CHECK ("customers"."bio" IS NULL OR char_length("customers"."bio") <= 280);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_avatar_key_check" CHECK ("customers"."avatar_key" IS NULL OR "customers"."avatar_key" ~ '^[a-z]{2,24}$');