-- CUSTOMER-AUTH-UX-02: AES-GCM sealed signup fields, single-use email proof.
-- The runtime derives the encryption key from CUSTOMER_EMAIL_AUTH_HMAC_SECRET; no password or
-- clear name/email is stored in this column. The pending field is nulled on proof consumption.
-- Not applied to any shared database by this development block.
ALTER TABLE "customer_auth_challenges" ADD COLUMN "registration_sealed_data" text;
--> statement-breakpoint
ALTER TABLE "customer_auth_challenges" ADD CONSTRAINT "customer_auth_challenges_registration_sealed_check"
  CHECK ("registration_sealed_data" IS NULL OR
    ("purpose" = 'email_registration' AND "customer_id" IS NULL AND length("registration_sealed_data") <= 4096));
