CREATE TABLE "loyalty_purchase_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL,
  "branch_id" uuid,
  "customer_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "loyalty_account_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "external_reference" text,
  "channel" text DEFAULT 'branch' NOT NULL,
  "qualifying_amount" numeric(10,2) NOT NULL,
  "payment_status" text DEFAULT 'confirmed' NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_purchase_events_channel_check" CHECK ("channel" IN ('branch','online','delivery','whatsapp','phone','other')),
  CONSTRAINT "loyalty_purchase_events_payment_status_check" CHECK ("payment_status" IN ('confirmed','refunded','reversed')),
  CONSTRAINT "loyalty_purchase_events_amount_check" CHECK ("qualifying_amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "loyalty_purchase_events" ADD CONSTRAINT "loyalty_purchase_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_purchase_events" ADD CONSTRAINT "loyalty_purchase_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_purchase_events" ADD CONSTRAINT "loyalty_purchase_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_purchase_events" ADD CONSTRAINT "loyalty_purchase_events_membership_id_business_customer_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."business_customer_memberships"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_purchase_events" ADD CONSTRAINT "loyalty_purchase_events_loyalty_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("loyalty_account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_purchase_events_business_idempotency_key" ON "loyalty_purchase_events" USING btree ("business_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "loyalty_purchase_events_account_occurred_idx" ON "loyalty_purchase_events" USING btree ("loyalty_account_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "loyalty_purchase_events_business_branch_occurred_idx" ON "loyalty_purchase_events" USING btree ("business_id","branch_id","occurred_at");
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "purchase_event_id" uuid;
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_purchase_event_id_loyalty_purchase_events_id_fk" FOREIGN KEY ("purchase_event_id") REFERENCES "public"."loyalty_purchase_events"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_transactions_purchase_event_key" ON "loyalty_transactions" USING btree ("purchase_event_id") WHERE "loyalty_transactions"."purchase_event_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_purchase_event_type_check" CHECK ("purchase_event_id" IS NULL OR "type" = 'purchase');
--> statement-breakpoint
UPDATE "qr_codes" SET "type" = 'business' WHERE "type" = 'feedback';
--> statement-breakpoint
ALTER TABLE "qr_codes" ALTER COLUMN "type" SET DEFAULT 'business';
