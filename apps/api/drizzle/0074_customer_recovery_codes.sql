CREATE TABLE "customer_recovery_code_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_session_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"attempts_window_started_at" timestamp with time zone,
	CONSTRAINT "customer_recovery_code_sets_revoked_check" CHECK (("customer_recovery_code_sets"."revoked_at" IS NULL) = ("customer_recovery_code_sets"."revoked_reason" IS NULL)),
	CONSTRAINT "customer_recovery_code_sets_reason_check" CHECK ("customer_recovery_code_sets"."revoked_reason" IS NULL OR "customer_recovery_code_sets"."revoked_reason" IN ('rotated', 'customer_revoked', 'security')),
	CONSTRAINT "customer_recovery_code_sets_attempts_check" CHECK ("customer_recovery_code_sets"."failed_attempts" >= 0 AND "customer_recovery_code_sets"."failed_attempts" <= 5)
);
--> statement-breakpoint
CREATE TABLE "customer_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"verifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "customer_recovery_codes_position_check" CHECK ("customer_recovery_codes"."position" BETWEEN 1 AND 8),
	CONSTRAINT "customer_recovery_codes_verifier_check" CHECK ("customer_recovery_codes"."verifier" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "customer_recovery_codes_consumption_check" CHECK ("customer_recovery_codes"."consumed_at" IS NULL OR "customer_recovery_codes"."consumed_at" >= "customer_recovery_codes"."created_at")
);
--> statement-breakpoint
ALTER TABLE "customer_auth_events" DROP CONSTRAINT "customer_auth_events_event_type_check";--> statement-breakpoint
ALTER TABLE "customer_recovery_code_sets" ADD CONSTRAINT "customer_recovery_code_sets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_recovery_codes" ADD CONSTRAINT "customer_recovery_codes_set_id_customer_recovery_code_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."customer_recovery_code_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_recovery_codes" ADD CONSTRAINT "customer_recovery_codes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recovery_code_sets_active_customer_uidx" ON "customer_recovery_code_sets" USING btree ("customer_id") WHERE "customer_recovery_code_sets"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "customer_recovery_code_sets_customer_created_idx" ON "customer_recovery_code_sets" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recovery_codes_set_position_uidx" ON "customer_recovery_codes" USING btree ("set_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recovery_codes_customer_verifier_uidx" ON "customer_recovery_codes" USING btree ("customer_id","verifier");--> statement-breakpoint
ALTER TABLE "customer_auth_events" ADD CONSTRAINT "customer_auth_events_event_type_check" CHECK ("customer_auth_events"."event_type" IN ('otp_requested', 'otp_verified', 'otp_failed', 'registration_completed', 'password_set', 'password_changed', 'password_login_succeeded', 'password_login_failed', 'recovery_started', 'recovery_completed', 'recovery_failed', 'session_created', 'session_refreshed', 'session_revoked', 'session_replay_detected', 'step_up_passed', 'step_up_failed', 'rate_limited', 'legacy_token_used', 'kill_switch_changed', 'recovery_code_issued', 'recovery_code_redeemed', 'recovery_code_failed', 'recovery_code_revoked'));