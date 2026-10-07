CREATE TABLE "business_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "group_key" text,
  "description" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_categories_key_key" ON "business_categories" USING btree ("key");
--> statement-breakpoint
CREATE INDEX "business_categories_group_key_idx" ON "business_categories" USING btree ("group_key");
--> statement-breakpoint
CREATE INDEX "business_categories_active_sort_idx" ON "business_categories" USING btree ("is_active","sort_order");
--> statement-breakpoint
INSERT INTO "business_categories" ("key","name","group_key","description","sort_order")
VALUES
  ('restaurant','Restaurant','food_and_beverage','Full-service or table-service restaurant.',10),
  ('cafe','Cafe','food_and_beverage','Cafe or coffee-focused food and beverage business.',20),
  ('bakery','Bakery','food_and_beverage','Bakery or baked-goods business.',30),
  ('fast_food','Fast Food','food_and_beverage','Quick-service or fast-food business.',40),
  ('catering','Catering','food_and_beverage','Catering and prepared-event food service.',50),
  ('salon','Salon',NULL,'Salon or personal-care service business.',60),
  ('hotel','Hotel',NULL,'Hotel or lodging business.',70)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "category_id" uuid;
--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_category_id_business_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."business_categories"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "businesses_category_id_idx" ON "businesses" USING btree ("category_id");
--> statement-breakpoint

-- Split 02: branch count is not the primary subscription meter and exact
-- branch limits remain commercially unresolved. Keep max_branches as legacy
-- billing metadata for Split 08 reconciliation, but stop enforcing it now.
DROP TRIGGER IF EXISTS branches_enforce_plan_limit ON "branches";
--> statement-breakpoint
DROP FUNCTION IF EXISTS echo_grid_enforce_branch_limit();
