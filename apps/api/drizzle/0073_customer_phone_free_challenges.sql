-- CUSTOMER-AUTH-01D-4b-S1: schema only; never execute outside disposable tests without separate approval.
ALTER TABLE "customers" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE "customer_auth_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid,
  "purpose" text NOT NULL,
  "subject_digest" text NOT NULL,
  "proof_digest" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "customer_auth_challenges_purpose_check" CHECK ("purpose" IN ('email_registration', 'email_link', 'email_recovery', 'email_change', 'phone_attach', 'phone_change')),
  CONSTRAINT "customer_auth_challenges_subject_digest_check" CHECK ("subject_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "customer_auth_challenges_proof_digest_check" CHECK ("proof_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "customer_auth_challenges_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 5 AND "attempts" <= "max_attempts"),
  CONSTRAINT "customer_auth_challenges_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "customer_auth_challenges_consumption_check" CHECK ("consumed_at" IS NULL OR ("consumed_at" >= "created_at" AND "consumed_at" <= "expires_at"))
);--> statement-breakpoint
ALTER TABLE "customer_auth_challenges" ADD CONSTRAINT "customer_auth_challenges_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_auth_challenges_subject_purpose_idx" ON "customer_auth_challenges" USING btree ("subject_digest","purpose","expires_at");--> statement-breakpoint
CREATE INDEX "customer_auth_challenges_expiry_idx" ON "customer_auth_challenges" USING btree ("expires_at");