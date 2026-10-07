CREATE TABLE "business_customer_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL,
  "business_id" uuid NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "left_at" timestamp with time zone,
  "suspended_at" timestamp with time zone,
  "business_exited_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "onboarding_source" text,
  "onboarding_reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  "is_deleted" boolean DEFAULT false NOT NULL,
  "deleted_at" timestamp with time zone,
  "deleted_by" uuid,
  CONSTRAINT "business_customer_memberships_status_check" CHECK ("status" IN ('pending','active','suspended','left','business_exited','closed'))
);
--> statement-breakpoint
CREATE TABLE "consent_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL,
  "business_id" uuid,
  "purpose" text NOT NULL,
  "scope" text,
  "resource_type" text,
  "resource_id" uuid,
  "consent_version" text DEFAULT 'v1' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "idempotency_key" text,
  "metadata" jsonb,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "consent_grants_purpose_check" CHECK ("purpose" IN ('join_loyalty','marketing','survey_participation','settlement_access','contact_sharing')),
  CONSTRAINT "consent_grants_status_check" CHECK ("status" IN ('active','revoked','expired','consumed'))
);
--> statement-breakpoint
CREATE TABLE "customer_action_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL,
  "business_id" uuid NOT NULL,
  "action_type" text NOT NULL,
  "resource_type" text,
  "resource_id" uuid,
  "scope" text,
  "issued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "status" text DEFAULT 'active' NOT NULL,
  "correlation_id" text NOT NULL,
  "idempotency_key" text,
  "metadata" jsonb,
  CONSTRAINT "customer_action_auth_action_type_check" CHECK ("action_type" IN ('redeem_reward','access_orphan_settlement','complete_settlement','share_contact_details')),
  CONSTRAINT "customer_action_auth_status_check" CHECK ("status" IN ('active','consumed','revoked','expired'))
);
--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD COLUMN "membership_id" uuid;
--> statement-breakpoint
ALTER TABLE "business_customer_memberships" ADD CONSTRAINT "business_customer_memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_customer_memberships" ADD CONSTRAINT "business_customer_memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "consent_grants" ADD CONSTRAINT "consent_grants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "consent_grants" ADD CONSTRAINT "consent_grants_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_action_authorizations" ADD CONSTRAINT "customer_action_authorizations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_action_authorizations" ADD CONSTRAINT "customer_action_authorizations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "business_customer_memberships_customer_business_key" ON "business_customer_memberships" USING btree ("customer_id","business_id");
--> statement-breakpoint
CREATE INDEX "business_customer_memberships_business_status_idx" ON "business_customer_memberships" USING btree ("business_id","status");
--> statement-breakpoint
CREATE INDEX "business_customer_memberships_customer_status_idx" ON "business_customer_memberships" USING btree ("customer_id","status");
--> statement-breakpoint
CREATE INDEX "consent_grants_customer_business_purpose_status_idx" ON "consent_grants" USING btree ("customer_id","business_id","purpose","status");
--> statement-breakpoint
CREATE INDEX "consent_grants_resource_idx" ON "consent_grants" USING btree ("resource_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "consent_grants_idempotency_key" ON "consent_grants" USING btree ("idempotency_key") WHERE "consent_grants"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "customer_action_auth_customer_business_action_status_idx" ON "customer_action_authorizations" USING btree ("customer_id","business_id","action_type","status");
--> statement-breakpoint
CREATE INDEX "customer_action_auth_expires_at_idx" ON "customer_action_authorizations" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_action_auth_idempotency_key" ON "customer_action_authorizations" USING btree ("idempotency_key") WHERE "customer_action_authorizations"."idempotency_key" IS NOT NULL;
--> statement-breakpoint

-- Deterministic legacy backfill: each current loyalty account already has a
-- unique (customer_id,business_id), so it maps one-to-one to a membership.
INSERT INTO "business_customer_memberships" (
  "customer_id",
  "business_id",
  "status",
  "joined_at",
  "suspended_at",
  "onboarding_source",
  "onboarding_reference",
  "created_at",
  "updated_at"
)
SELECT
  la."customer_id",
  la."business_id",
  CASE WHEN la."status" = 'suspended' THEN 'suspended' ELSE 'active' END,
  la."created_at",
  CASE WHEN la."status" = 'suspended' THEN COALESCE(la."updated_at", now()) ELSE NULL END,
  'legacy_migration',
  la."id"::text,
  la."created_at",
  la."updated_at"
FROM "loyalty_accounts" la
ON CONFLICT ("customer_id","business_id") DO NOTHING;
--> statement-breakpoint

UPDATE "loyalty_accounts" la
SET "membership_id" = bcm."id"
FROM "business_customer_memberships" bcm
WHERE bcm."customer_id" = la."customer_id"
  AND bcm."business_id" = la."business_id"
  AND la."membership_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_membership_id_business_customer_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."business_customer_memberships"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_accounts_membership_id_key" ON "loyalty_accounts" USING btree ("membership_id") WHERE "loyalty_accounts"."membership_id" IS NOT NULL;
