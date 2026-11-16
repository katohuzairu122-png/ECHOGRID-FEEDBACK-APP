ALTER TABLE "customers" DROP CONSTRAINT "customers_phone_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "customers_phone_verified_unique" ON "customers" USING btree ("phone") WHERE "customers"."phone_verified_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");